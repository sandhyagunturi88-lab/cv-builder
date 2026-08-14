'use strict';

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { createAnthropicClient, generateCV, suggestIdeas, polishEntry, extractCV } = require('./lib/anthropic');
const { createLicensing } = require('./lib/licensing');
const { createLemonSqueezyProvider } = require('./lib/providers/lemonsqueezy');

const HOUR_MS = 60 * 60 * 1000;

// Privacy: this logger records timestamps and statuses only — never CV facts,
// generated output, license keys, or request bodies.
function logEvent(route, status) {
  console.log(`${new Date().toISOString()} ${route} ${status}`);
}

function createRateLimiter() {
  const hits = new Map(); // bucket key -> array of hit timestamps
  return {
    allow(key, limit, windowMs = HOUR_MS) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}

/**
 * App factory. Options override env vars so tests can inject stubs:
 *   anthropic  — client with messages.create()
 *   provider   — payment-provider implementation (see lib/providers/); defaults
 *                to Lemon Squeezy built from env config
 *   lsFetch    — fetch implementation passed to the default Lemon Squeezy provider
 */
function createApp(options = {}) {
  const config = {
    betaMode: options.betaMode ?? (process.env.BETA_MODE ?? 'true') !== 'false',
    checkoutUrl: options.checkoutUrl ?? process.env.LEMONSQUEEZY_CHECKOUT_URL ?? '',
    webhookSecret: options.webhookSecret ?? process.env.LEMONSQUEEZY_WEBHOOK_SECRET ?? '',
    lsApiKey: options.lsApiKey ?? process.env.LEMONSQUEEZY_API_KEY ?? '',
    betaRateLimit: options.betaRateLimit ?? 10,
    paidRateLimit: options.paidRateLimit ?? 30,
  };

  // Payment provider is pluggable — swap Lemon Squeezy for Dodo Payments or
  // Paddle by passing a different provider (see lib/providers/lemonsqueezy.js
  // for the interface).
  const provider =
    options.provider ||
    createLemonSqueezyProvider({
      apiKey: config.lsApiKey,
      webhookSecret: config.webhookSecret,
      fetchImpl: options.lsFetch,
    });

  const licensing = createLicensing({
    betaMode: config.betaMode,
    checkoutUrl: config.checkoutUrl,
    provider,
  });
  const rateLimiter = createRateLimiter();

  let anthropic = options.anthropic || null;
  function getAnthropic() {
    if (!anthropic) {
      if (!process.env.ANTHROPIC_API_KEY) return null;
      anthropic = createAnthropicClient(process.env.ANTHROPIC_API_KEY);
    }
    return anthropic;
  }

  const app = express();
  app.set('trust proxy', true); // respect X-Forwarded-For behind Render/Railway/Fly

  // Webhook first: it needs the raw body (for signature verification) before
  // any JSON parsing. Verification and event interpretation are delegated to
  // the provider via licensing.handleWebhook. /api/ls-webhook is kept as an
  // alias for existing Lemon Squeezy webhook registrations.
  const webhookRoute = (req, res) => {
    const { status, body } = licensing.handleWebhook(req.body, (name) => req.get(name));
    logEvent('payments-webhook', status);
    res.status(status).json(body);
  };
  app.post('/api/payments-webhook', express.raw({ type: () => true }), webhookRoute);
  app.post('/api/ls-webhook', express.raw({ type: () => true }), webhookRoute);

  // Shared gate for AI routes: license check + rate limit (one hourly bucket
  // covers generations AND suggestions). Sends the error response and returns
  // null when the request is refused.
  async function gateAIRequest(req, res, route) {
    const access = await licensing.checkAccess(req);
    if (!access.allowed) {
      logEvent(route, 402);
      res.status(402).json({ error: access.error, checkoutUrl: config.checkoutUrl });
      return null;
    }
    const bucket = access.beta ? `ip:${req.ip}` : `key:${access.licenseKey}`;
    const limit = access.beta ? config.betaRateLimit : config.paidRateLimit;
    if (!rateLimiter.allow(bucket, limit)) {
      logEvent(route, 429);
      res.status(429).json({
        error: `Rate limit reached (${limit} generations per hour). Please try again later.`,
        beta: !!access.beta,
      });
      return null;
    }
    return access;
  }

  app.post('/api/generate-cv', express.json({ limit: '200kb' }), async (req, res) => {
    const access = await gateAIRequest(req, res, 'generate-cv');
    if (!access) return;

    const facts = req.body && req.body.facts;
    if (typeof facts !== 'string' || !facts.trim()) {
      logEvent('generate-cv', 400);
      return res.status(400).json({ error: 'Request body must include a non-empty "facts" string.' });
    }

    const client = getAnthropic();
    if (!client) {
      logEvent('generate-cv', 500);
      return res.status(500).json({ error: 'Server is not configured with an ANTHROPIC_API_KEY.' });
    }

    try {
      const result = await generateCV(client, facts);
      logEvent('generate-cv', 200);
      res.json({ result, beta: !!access.beta });
    } catch (err) {
      // Log status only — never the facts or the model output.
      logEvent('generate-cv', 502);
      res.status(502).json({ error: 'CV generation failed. Please try again in a moment.' });
    }
  });

  app.post('/api/suggest', express.json({ limit: '50kb' }), async (req, res) => {
    const access = await gateAIRequest(req, res, 'suggest');
    if (!access) return;

    const context = req.body && req.body.context;
    if (typeof context !== 'string' || !context.trim()) {
      logEvent('suggest', 400);
      return res.status(400).json({ error: 'Request body must include a non-empty "context" string.' });
    }

    const client = getAnthropic();
    if (!client) {
      logEvent('suggest', 500);
      return res.status(500).json({ error: 'Server is not configured with an ANTHROPIC_API_KEY.' });
    }

    try {
      const result = await suggestIdeas(client, context);
      logEvent('suggest', 200);
      res.json({ result, beta: !!access.beta });
    } catch (err) {
      logEvent('suggest', 502);
      res.status(502).json({ error: 'Suggestion generation failed. Please try again in a moment.' });
    }
  });

  const POLISH_CATEGORIES = new Set([
    'project', 'achievement', 'skill',          // step 3
    'job', 'responsibility',                    // step 4
    'sport', 'award', 'interest',               // step 5
  ]);
  app.post('/api/polish', express.json({ limit: '50kb' }), async (req, res) => {
    const access = await gateAIRequest(req, res, 'polish');
    if (!access) return;

    const { category, text, target } = req.body || {};
    if (!POLISH_CATEGORIES.has(category) || typeof text !== 'string' || !text.trim()) {
      logEvent('polish', 400);
      return res.status(400).json({
        error: 'Body must include a category ("project" | "achievement" | "skill") and a non-empty "text".',
      });
    }

    const client = getAnthropic();
    if (!client) {
      logEvent('polish', 500);
      return res.status(500).json({ error: 'Server is not configured with an ANTHROPIC_API_KEY.' });
    }

    try {
      const result = await polishEntry(client, {
        category,
        text,
        target: typeof target === 'string' ? target : '',
      });
      logEvent('polish', 200);
      res.json({ result, beta: !!access.beta });
    } catch (err) {
      logEvent('polish', 502);
      res.status(502).json({ error: 'Writing failed. Please try again in a moment.' });
    }
  });

  // CV import: file is held in memory only (never written to disk), its text
  // extracted, structured by the model, and discarded — nothing is stored.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  app.post('/api/import-cv', upload.single('file'), express.json({ limit: '1mb' }), async (req, res) => {
    const access = await gateAIRequest(req, res, 'import-cv');
    if (!access) return;

    let text = '';
    try {
      if (req.file) {
        const name = (req.file.originalname || '').toLowerCase();
        if (name.endsWith('.pdf')) text = (await pdfParse(req.file.buffer)).text;
        else if (name.endsWith('.docx')) text = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
        else text = req.file.buffer.toString('utf8');
      } else if (req.body && typeof req.body.text === 'string') {
        text = req.body.text;
      }
    } catch (err) {
      logEvent('import-cv', 400);
      return res.status(400).json({ error: 'Could not read that file. Upload a PDF, DOCX or plain-text CV.' });
    }
    if (!text.trim()) {
      logEvent('import-cv', 400);
      return res.status(400).json({ error: 'Upload a PDF, DOCX or text file (or send "text") containing your CV.' });
    }

    const client = getAnthropic();
    if (!client) {
      logEvent('import-cv', 500);
      return res.status(500).json({ error: 'Server is not configured with an ANTHROPIC_API_KEY.' });
    }

    try {
      const result = await extractCV(client, text.slice(0, 15000));
      logEvent('import-cv', 200);
      res.json({ result, beta: !!access.beta });
    } catch (err) {
      logEvent('import-cv', 502);
      res.status(502).json({ error: 'Import failed. Please try again in a moment.' });
    }
  });

  app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
  });

  // Landing page at / (template chooser), builder at /app.
  app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'cv-builder.html'));
  });

  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  require('dotenv').config();
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(port, () => {
    const beta = (process.env.BETA_MODE ?? 'true') !== 'false';
    console.log(`CV Builder listening on http://localhost:${port} (beta mode: ${beta ? 'ON — free for everyone' : 'off — licence keys required'})`);
  });
}
