'use strict';

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { createAnthropicClient, generateCV, suggestIdeas, polishEntry, extractCV, tailorToJob, diagnoseCV, keywordGapExtract, keywordGapDiff, interviewTurn, ModelRefusalError, ModelTruncatedError } = require('./lib/anthropic');
const { createLicensing } = require('./lib/licensing');
const { createLemonSqueezyProvider } = require('./lib/providers/lemonsqueezy');

const HOUR_MS = 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * HOUR_MS; // rolling 30-day window, not calendar-month

// Privacy: this logger records timestamps and statuses only — never CV facts,
// generated output, license keys, or request bodies.
function logEvent(route, status) {
  console.log(`${new Date().toISOString()} ${route} ${status}`);
}

// Maps the typed model errors (lib/anthropic.js) to their specified 502
// responses. Returns true (and sends the response) if it handled the error;
// false if the caller should fall through to its own generic 502.
function handleModelError(err, res, route) {
  if (err instanceof ModelRefusalError) {
    logEvent(route, 502);
    res.status(502).json({ error: 'The AI declined this content — edit your text and try again.' });
    return true;
  }
  if (err instanceof ModelTruncatedError) {
    logEvent(route, 502);
    res.status(502).json({ error: 'The response was too long — try shorter input.' });
    return true;
  }
  return false;
}

// Typed errors from computeRoleCorpus (see /api/keyword-gap below) so its
// caller(s) can map failures to the right HTTP status even when the call was
// shared across concurrent requests via roleCorpusInflight.
class CorpusUnavailableError extends Error {}
class CorpusEmptyError extends Error {}

// Bounded-Map insert for the keyword-gap per-role cache, factored out (pure,
// no closure state) so its eviction logic can be unit-tested directly
// without wall-clock TTL manipulation. Only evicts when actually inserting a
// NEW key at capacity -- Map.set on an EXISTING key doesn't grow .size (so a
// size-only eviction check would wrongly evict an unrelated entry every time
// a popular role's stale entry gets refreshed) and doesn't move the key in
// iteration order (so a refresh needs delete-then-set to be promoted to
// "newest" -- oldest-eviction below relies on Map's insertion-order
// iteration to find the true oldest entry).
function cacheRoleCorpus(cache, maxSize, key, value) {
  if (cache.has(key)) {
    cache.delete(key); // refresh: drop and re-add so it's promoted to newest
  } else if (cache.size >= maxSize) {
    cache.delete(cache.keys().next().value); // genuinely full: evict oldest
  }
  cache.set(key, value);
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
    // Paid-only by default: every AI route needs a licence key unless
    // BETA_MODE=true is set explicitly (local testing / promos).
    betaMode: options.betaMode ?? (process.env.BETA_MODE ?? 'false') === 'true',
    checkoutUrl: options.checkoutUrl ?? process.env.LEMONSQUEEZY_CHECKOUT_URL ?? '',
    webhookSecret: options.webhookSecret ?? process.env.LEMONSQUEEZY_WEBHOOK_SECRET ?? '',
    lsApiKey: options.lsApiKey ?? process.env.LEMONSQUEEZY_API_KEY ?? '',
    betaRateLimit: options.betaRateLimit ?? 10,
    paidRateLimit: options.paidRateLimit ?? 30,
    // Monthly cap on top of the hourly rate limit, to bound worst-case spend.
    // Rolling 30-day window, checked per licence key (or per IP in beta mode).
    monthlyAiLimit: options.monthlyAiLimit ?? (Number(process.env.MONTHLY_AI_LIMIT) || 300),
    betaMonthlyAiLimit: options.betaMonthlyAiLimit ?? 100,
    // Unlicensed ATS checks per IP per day (each spends one model call).
    freeDiagnoseLimit: options.freeDiagnoseLimit ?? 3,
    // Mock interviews are ~8 model calls per session, so they get their own
    // buckets: per-hour turns plus a daily session cap per key/IP.
    interviewRateLimit: options.interviewRateLimit ?? 60,
    betaInterviewRateLimit: options.betaInterviewRateLimit ?? 20,
    interviewDailyLimit: options.interviewDailyLimit ?? 5,
    // Role keyword gap needs the JobPilot API for its job-description corpus.
    // Unset (the default) hides the feature entirely — CV Studio stays standalone.
    jobpilotApiUrl: options.jobpilotApiUrl ?? process.env.JOBPILOT_API_URL ?? '',
    jobpilotApiToken: options.jobpilotApiToken ?? process.env.JOBPILOT_API_TOKEN ?? '',
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

  // Per-role cache for keyword-gap's in-demand extraction (the expensive
  // half of that route -- see /api/keyword-gap below). Per-app-instance,
  // like rateLimiter above, so tests stay isolated from each other.
  const roleCorpusCache = new Map(); // roleKey -> { inDemand, adverts, computedAt }
  // In-flight extraction promises, keyed the same way, so concurrent
  // requests for the same not-yet-cached role share one corpus fetch +
  // extraction instead of each doing it independently.
  const roleCorpusInflight = new Map(); // roleKey -> Promise<{ inDemand, adverts }>
  const KEYWORD_GAP_CACHE_TTL_MS = 24 * HOUR_MS;
  // Test-overridable (default 500) so eviction behavior can be exercised
  // without driving 500+ distinct roles through the route.
  const KEYWORD_GAP_CACHE_MAX = options.keywordGapCacheMax ?? 500;

  let anthropic = options.anthropic || null;
  function getAnthropic() {
    if (!anthropic) {
      if (!process.env.ANTHROPIC_API_KEY) return null;
      anthropic = createAnthropicClient(process.env.ANTHROPIC_API_KEY);
    }
    return anthropic;
  }

  const app = express();
  // Exactly ONE proxy hop (Render/Railway/Fly's edge). `true` would trust the
  // whole X-Forwarded-For chain, letting clients spoof req.ip with a header —
  // and req.ip keys the beta/free-tier rate-limit buckets.
  app.set('trust proxy', 1);

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

  // Monthly cap on top of the hourly bucket, to bound worst-case spend beyond
  // what the hourly limit alone allows. Rolling 30-day window. Uses a
  // "monthly:" bucket-key prefix so it never collides with the hourly
  // bucket's "key:"/"ip:" keys in the same in-memory rateLimiter -- without
  // the distinct prefix the two windows' hit-count arrays would corrupt
  // each other. Sends the 429 response and returns true when the request is
  // refused; shared by gateAIRequest and /api/import-cv's own inline gate
  // (import-cv doesn't route through gateAIRequest -- see below).
  function checkMonthlyLimit(access, req, res, route) {
    const bucket = access.beta ? `monthly:ip:${req.ip}` : `monthly:key:${access.licenseKey}`;
    const limit = access.beta ? config.betaMonthlyAiLimit : config.monthlyAiLimit;
    if (!rateLimiter.allow(bucket, limit, MONTH_MS)) {
      logEvent(route, 429);
      res.status(429).json({ error: "You've reached this month's AI limit." });
      return true;
    }
    return false;
  }

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
    if (checkMonthlyLimit(access, req, res, route)) {
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
      const result = await generateCV(client, facts.slice(0, 20000));
      logEvent('generate-cv', 200);
      res.json({ result, beta: !!access.beta });
    } catch (err) {
      // Log status only — never the facts or the model output.
      if (handleModelError(err, res, 'generate-cv')) return;
      logEvent('generate-cv', 502);
      res.status(502).json({ error: 'CV generation failed. Please try again in a moment.' });
    }
  });

  app.post('/api/tailor', express.json({ limit: '200kb' }), async (req, res) => {
    const access = await gateAIRequest(req, res, 'tailor');
    if (!access) return;

    const { job, facts } = req.body || {};
    if (typeof job !== 'string' || !job.trim() || typeof facts !== 'string' || !facts.trim()) {
      logEvent('tailor', 400);
      return res.status(400).json({ error: 'Body must include non-empty "job" and "facts" strings.' });
    }

    const client = getAnthropic();
    if (!client) {
      logEvent('tailor', 500);
      return res.status(500).json({ error: 'Server is not configured with an ANTHROPIC_API_KEY.' });
    }

    try {
      const result = await tailorToJob(client, { job: job.slice(0, 20000), facts: facts.slice(0, 20000) });
      logEvent('tailor', 200);
      res.json({ result, beta: !!access.beta });
    } catch (err) {
      if (handleModelError(err, res, 'tailor')) return;
      logEvent('tailor', 502);
      res.status(502).json({ error: 'Tailoring failed. Please try again in a moment.' });
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
      const result = await suggestIdeas(client, context.slice(0, 20000));
      logEvent('suggest', 200);
      res.json({ result, beta: !!access.beta });
    } catch (err) {
      if (handleModelError(err, res, 'suggest')) return;
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
      if (handleModelError(err, res, 'polish')) return;
      logEvent('polish', 502);
      res.status(502).json({ error: 'Writing failed. Please try again in a moment.' });
    }
  });

  // Parses a model reply that should be raw JSON, tolerating stray code fences.
  // Returns null (never throws) so routes can turn bad output into a clean 502.
  function parseModelJson(text) {
    try {
      return JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim());
    } catch {
      return null;
    }
  }

  // No-AI ATS check for the free tier: pure heuristics over the raw text —
  // the same rules an ATS trips on — so the teaser costs ZERO model calls,
  // mirroring the free import. Severity weights: high 20, medium 10, low 5.
  function basicDiagnose(text) {
    const flags = [];
    const add = (severity, section, problem, fix) => flags.push({ severity, section, problem, fix });
    const lower = text.toLowerCase();

    if (!/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(text)) {
      add('high', 'Contact details', 'No email address found — an ATS cannot file the application.',
        'Add a sensible email address near the top, plain text.');
    }
    if (!/(?:\+44\s?7\d{3}|07\d{3})[\s-]?\d{3}[\s-]?\d{3}/.test(text)) {
      add('medium', 'Contact details', 'No UK phone number found.',
        'Add your mobile number next to your email.');
    }
    if (((text.match(/\b(?:19|20)\d{2}\b/g) || []).length) < 2) {
      add('high', 'Dates', 'Few or no dates found — recruiters and ATS filters need a timeline.',
        'Add years to your education and any experience (e.g. "2019 – 2026").');
    }
    for (const [name, re] of [
      ['Education', /education|a level|gcse|school|college/],
      ['Skills', /skills/],
      ['Experience or projects', /experience|employment|work|project/],
    ]) {
      if (!re.test(lower)) {
        add('medium', name, `No recognisable "${name}" content found — standard headings are what an ATS looks for.`,
          `Add a clearly-headed ${name.toLowerCase()} section.`);
      }
    }
    if (text.length < 900) {
      add('low', 'Overall', 'The CV is very short — a skim gives a recruiter little to say yes to.',
        'Fill in more of the builder steps; even small true items help.');
    } else if (text.length > 6500) {
      add('low', 'Overall', 'The CV looks longer than one page — school-leaver CVs should fit on one.',
        'Cut the weakest items; keep the strongest evidence for your target role.');
    }

    const order = { high: 0, medium: 1, low: 2 };
    flags.sort((a, b) => order[a.severity] - order[b.severity]);
    const score = Math.max(5, 100 - flags.reduce(
      (sum, f) => sum + (f.severity === 'high' ? 20 : f.severity === 'medium' ? 10 : 5), 0));
    const summary =
      flags.length === 0
        ? 'No basic parsing problems found — the AI check digs into wording, evidence and keywords.'
        : `Automatic checks found ${flags.length} thing${flags.length > 1 ? 's' : ''} likely to trip an ATS or a skim-read.`;
    return { score, summary, flags };
  }

  // ATS health check. Two-tier like import-cv: without a licence it is a FREE
  // deterministic teaser (basicDiagnose above — no model call, no cost) showing
  // the score + the single worst flag. A licence gets the full AI report,
  // drawing from the normal hourly bucket.
  const DAY_MS = 24 * HOUR_MS;
  app.post('/api/diagnose', express.json({ limit: '100kb' }), async (req, res) => {
    const text = req.body && req.body.text;
    if (typeof text !== 'string' || !text.trim()) {
      logEvent('diagnose', 400);
      return res.status(400).json({ error: 'Request body must include a non-empty "text" string.' });
    }
    const access = await licensing.checkAccess(req);
    if (!access.allowed) {
      // Free teaser: deterministic heuristics only — NO model call, no cost.
      // Score + the worst flag are the hook; the full AI report is paid.
      if (!rateLimiter.allow(`diagfree:${req.ip}`, config.freeDiagnoseLimit, DAY_MS)) {
        logEvent('diagnose', 429);
        return res.status(429).json({
          error: `Free CV checks are limited to ${config.freeDiagnoseLimit} per day. Unlock unlimited AI checks with a licence.`,
          checkoutUrl: config.checkoutUrl,
        });
      }
      const basic = basicDiagnose(text.slice(0, 20000));
      logEvent('diagnose', 200);
      return res.json({
        result: { score: basic.score, summary: basic.summary, flags: basic.flags.slice(0, 1) },
        locked: Math.max(0, basic.flags.length - 1),
        ai: false,
        upgrade: true,
        checkoutUrl: config.checkoutUrl,
      });
    }

    const bucket = access.beta ? `ip:${req.ip}` : `key:${access.licenseKey}`;
    const limit = access.beta ? config.betaRateLimit : config.paidRateLimit;
    if (!rateLimiter.allow(bucket, limit)) {
      logEvent('diagnose', 429);
      return res.status(429).json({
        error: `Rate limit reached (${limit} generations per hour). Please try again later.`,
        beta: !!access.beta,
      });
    }
    // diagnose's paid path doesn't route through gateAIRequest (it has its
    // own two-tier free/paid gate above), so the monthly cap is applied here
    // directly -- this previously bypassed the monthly cap entirely.
    if (checkMonthlyLimit(access, req, res, 'diagnose')) return;
    const client = getAnthropic();
    if (!client) {
      logEvent('diagnose', 500);
      return res.status(500).json({ error: 'Server is not configured with an ANTHROPIC_API_KEY.' });
    }
    try {
      const raw = await diagnoseCV(client, text.slice(0, 20000));
      const parsed = parseModelJson(raw);
      if (!parsed || typeof parsed.score !== 'number' || !Array.isArray(parsed.flags)) {
        logEvent('diagnose', 502);
        return res.status(502).json({ error: 'CV check failed. Please try again in a moment.' });
      }
      logEvent('diagnose', 200);
      res.json({ result: parsed, locked: 0, ai: true, beta: !!access.beta });
    } catch (err) {
      if (handleModelError(err, res, 'diagnose')) return;
      logEvent('diagnose', 502);
      res.status(502).json({ error: 'CV check failed. Please try again in a moment.' });
    }
  });

  // Feature discovery: the front end asks what optional features this deploy
  // has. Ungated and free — it reveals configuration, never data.
  app.get('/api/features', (req, res) => {
    res.json({
      keywordGap: !!config.jobpilotApiUrl,
      // Lets the front end grey out (lock) AI buttons for unlicensed visitors
      // when AI is paid-only, and link them straight to checkout.
      beta: !!config.betaMode,
      checkoutUrl: config.checkoutUrl,
    });
  });

  // Role keyword gap: pulls a corpus of real ingested job adverts for the
  // target role from the JobPilot API, then has the model diff the CV facts
  // against what those adverts actually ask for. Feature-flagged: without
  // JOBPILOT_API_URL the route reports itself unavailable and the front end
  // hides the panel — CV Studio keeps working standalone.
  const corpusFetch = options.corpusFetch || fetch;

  // Fetches the role's advert corpus from the JobPilot API and extracts its
  // in-demand skills via the model, then caches the result. Shared (via
  // roleCorpusInflight below) across concurrent requests for the same
  // not-yet-cached role, so they pay for one corpus fetch + extraction
  // between them instead of one each. Throws CorpusUnavailableError /
  // CorpusEmptyError / the typed model errors / a generic Error on bad
  // model output -- the caller maps each to its HTTP response.
  async function computeRoleCorpus(client, roleKey, role) {
    let jobs;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let resp;
      try {
        const url = new URL('/api/v1/jobs/role-corpus', config.jobpilotApiUrl);
        url.searchParams.set('role', role);
        url.searchParams.set('limit', '40');
        resp = await corpusFetch(url.href, {
          signal: controller.signal,
          headers: config.jobpilotApiToken
            ? { Authorization: `Bearer ${config.jobpilotApiToken}` }
            : {},
        });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new Error(`corpus fetch status ${resp.status}`);
      jobs = (await resp.json()).jobs || [];
    } catch {
      throw new CorpusUnavailableError('The live job pool is unreachable right now.');
    }
    if (!jobs.length) {
      throw new CorpusEmptyError('No current adverts found for that role.');
    }

    const corpus = jobs
      .map((j) => `--- ${j.title}\n${String(j.jd_text || '').slice(0, 2000)}`)
      .join('\n\n')
      .slice(0, 90000);
    const raw = await keywordGapExtract(client, { role, corpus });
    const parsed = parseModelJson(raw);
    if (!parsed || !Array.isArray(parsed.in_demand)) {
      throw new Error('keyword-gap extraction returned an unexpected shape');
    }
    const inDemand = parsed.in_demand;
    const adverts = jobs.length;
    cacheRoleCorpus(roleCorpusCache, KEYWORD_GAP_CACHE_MAX, roleKey, { inDemand, adverts, computedAt: Date.now() });
    return { inDemand, adverts };
  }

  app.post('/api/keyword-gap', express.json({ limit: '100kb' }), async (req, res) => {
    if (!config.jobpilotApiUrl) {
      logEvent('keyword-gap', 503);
      return res.status(503).json({ error: 'Role insights are not enabled on this server.' });
    }
    const { role: rawRole, facts } = req.body || {};
    const role = typeof rawRole === 'string' ? rawRole.slice(0, 200) : rawRole;
    if (typeof role !== 'string' || !role.trim() || typeof facts !== 'string' || !facts.trim()) {
      logEvent('keyword-gap', 400);
      return res.status(400).json({ error: 'Body must include non-empty "role" and "facts" strings.' });
    }
    const access = await gateAIRequest(req, res, 'keyword-gap');
    if (!access) return;
    const client = getAnthropic();
    if (!client) {
      logEvent('keyword-gap', 500);
      return res.status(500).json({ error: 'Server is not configured with an ANTHROPIC_API_KEY.' });
    }

    // Per-role cache (24h TTL): on a hit, skip the corpus fetch AND the
    // extraction call entirely -- only the cheap per-user diff call below
    // runs. This is the biggest single saving in the cost refactor: the full
    // ~90K-char corpus previously went to the model on every request.
    const roleKey = role.trim().toLowerCase();
    const cached = roleCorpusCache.get(roleKey);
    let inDemand;
    let adverts;

    if (cached && Date.now() - cached.computedAt < KEYWORD_GAP_CACHE_TTL_MS) {
      inDemand = cached.inDemand;
      adverts = cached.adverts;
    } else {
      // Share one in-flight computation across concurrent requests for the
      // same uncached role -- registered synchronously (no await between
      // the .get() and .set() below) so two requests arriving back-to-back
      // can't both miss the inflight map.
      let inflight = roleCorpusInflight.get(roleKey);
      if (!inflight) {
        inflight = computeRoleCorpus(client, roleKey, role).finally(() => {
          if (roleCorpusInflight.get(roleKey) === inflight) {
            roleCorpusInflight.delete(roleKey);
          }
        });
        roleCorpusInflight.set(roleKey, inflight);
      }
      try {
        ({ inDemand, adverts } = await inflight);
      } catch (err) {
        if (err instanceof CorpusUnavailableError) {
          logEvent('keyword-gap', 503);
          return res.status(503).json({
            error: 'The live job pool is unreachable right now — please try again in a few minutes.',
          });
        }
        if (err instanceof CorpusEmptyError) {
          logEvent('keyword-gap', 422);
          return res.status(422).json({
            error: 'No current adverts found for that role — try a broader role name.',
          });
        }
        if (handleModelError(err, res, 'keyword-gap')) return;
        logEvent('keyword-gap', 502);
        return res.status(502).json({ error: 'Role insight failed. Please try again in a moment.' });
      }
    }

    // Per-user diff: runs on every request (cache hit or miss), since
    // matched/missing depend on this specific user's facts.
    try {
      const raw = await keywordGapDiff(client, { role, inDemand, facts: facts.slice(0, 20000) });
      const parsed = parseModelJson(raw);
      if (!parsed || !Array.isArray(parsed.matched) || !Array.isArray(parsed.missing)) {
        logEvent('keyword-gap', 502);
        return res.status(502).json({ error: 'Role insight failed. Please try again in a moment.' });
      }
      logEvent('keyword-gap', 200);
      res.json({
        result: { in_demand: inDemand, matched: parsed.matched, missing: parsed.missing },
        adverts,
        beta: !!access.beta,
      });
    } catch (err) {
      if (handleModelError(err, res, 'keyword-gap')) return;
      logEvent('keyword-gap', 502);
      res.status(502).json({ error: 'Role insight failed. Please try again in a moment.' });
    }
  });

  // Mock interview. One session is ~8 model calls, so interviews have their
  // OWN limits instead of the shared generation bucket: an hourly turn bucket
  // plus a daily session cap (a session starts when the transcript is empty).
  app.post('/api/interview', express.json({ limit: '200kb' }), async (req, res) => {
    const { role, advert, facts, transcript } = req.body || {};
    if (typeof role !== 'string' || !role.trim() || typeof facts !== 'string' || !facts.trim()) {
      logEvent('interview', 400);
      return res.status(400).json({ error: 'Body must include non-empty "role" and "facts" strings.' });
    }
    const turns = (Array.isArray(transcript) ? transcript : [])
      .filter(
        (m) =>
          m && (m.role === 'assistant' || m.role === 'user') && typeof m.content === 'string' && m.content.trim()
      )
      .slice(-40)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

    const access = await licensing.checkAccess(req);
    if (!access.allowed) {
      logEvent('interview', 402);
      return res.status(402).json({ error: access.error, checkoutUrl: config.checkoutUrl });
    }
    const who = access.beta ? `ip:${req.ip}` : `key:${access.licenseKey}`;
    const hourly = access.beta ? config.betaInterviewRateLimit : config.interviewRateLimit;
    if (!rateLimiter.allow(`interview:${who}`, hourly)) {
      logEvent('interview', 429);
      return res.status(429).json({
        error: 'Interview practice is rate limited for the moment — please continue in a little while.',
        beta: !!access.beta,
      });
    }
    if (turns.length === 0 && !rateLimiter.allow(`interviewday:${who}`, config.interviewDailyLimit, DAY_MS)) {
      logEvent('interview', 429);
      return res.status(429).json({
        error: `Daily limit of ${config.interviewDailyLimit} practice interviews reached — come back tomorrow.`,
        beta: !!access.beta,
      });
    }

    const client = getAnthropic();
    if (!client) {
      logEvent('interview', 500);
      return res.status(500).json({ error: 'Server is not configured with an ANTHROPIC_API_KEY.' });
    }
    try {
      const raw = await interviewTurn(client, {
        role: role.slice(0, 200),
        advert: typeof advert === 'string' ? advert.slice(0, 20000) : '',
        facts: facts.slice(0, 20000),
        transcript: turns,
      });
      const parsed = parseModelJson(raw);
      if (!parsed || typeof parsed.done !== 'boolean' || (!parsed.done && typeof parsed.next_question !== 'string')) {
        logEvent('interview', 502);
        return res.status(502).json({ error: 'The interviewer lost their train of thought. Please try again.' });
      }
      logEvent('interview', 200);
      res.json({ result: parsed, beta: !!access.beta });
    } catch (err) {
      if (handleModelError(err, res, 'interview')) return;
      logEvent('interview', 502);
      res.status(502).json({ error: 'The interviewer lost their train of thought. Please try again.' });
    }
  });

  // CV import: file is held in memory only (never written to disk), its text
  // extracted, structured by the model, and discarded — nothing is stored.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

  // Word-compatible HTML (like our old .doc export) back to plain text.
  function htmlToText(html) {
    return html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Reads PDF/DOCX/plain-text into raw text. Shared by /api/import-cv (which
  // then structures it with the model) and /api/extract-text (which doesn't).
  // .doc files are usually either our old export (HTML in a Word wrapper —
  // converted back to text; the app now exports real .docx) or legacy binary
  // Word (rejected with a clear message, since nothing here can parse OLE).
  async function extractFileText(file) {
    const name = (file.originalname || '').toLowerCase();
    if (name.endsWith('.pdf')) return (await pdfParse(file.buffer)).text;
    if (name.endsWith('.docx')) return (await mammoth.extractRawText({ buffer: file.buffer })).value;
    if (file.buffer.length >= 4 && file.buffer.readUInt32BE(0) === 0xd0cf11e0) {
      const err = new Error(
        'That is an old-format binary .doc file — open it in Word and save as .docx or PDF, then upload again.'
      );
      err.status = 415;
      throw err;
    }
    const text = file.buffer.toString('utf8').replace(/^﻿/, ''); // strip UTF-8 BOM
    if (/^\s*(?:<!doctype|<html)/i.test(text) || /urn:schemas-microsoft-com:office/i.test(text)) {
      return htmlToText(text);
    }
    return text;
  }

  // CVs are very often named after their owner ("Jane Smith_CV.docx") while
  // the name itself sits in a Word header that text extraction can't see.
  // Derive a name from the filename when it looks like one — letters only,
  // 1-4 words after stripping cv/resume noise.
  function nameFromFilename(originalname) {
    const cleaned = (originalname || '')
      .replace(/\.[^.]+$/, '')
      .replace(/[_\-.]+/g, ' ') // separators first, so "_CV" gets a word boundary
      .replace(/\b(cv|resume|curriculum|vitae|final|updated|copy|draft|v\d+)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || /[^a-z ']/i.test(cleaned)) return '';
    const words = cleaned.split(' ');
    if (words.length > 4) return '';
    return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  }

  // No-AI import fallback: regex-only extraction of the details that can be
  // found with certainty (contact info). Everything else stays empty rather
  // than guessed — the honesty rule applies to us too.
  function basicExtract(text) {
    const email = (text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0];
    const phone = ((text.match(/(?:\+44\s?7\d{3}|07\d{3})[\s-]?\d{3}[\s-]?\d{3}/) || [''])[0]).trim();
    const links = (text.match(/(?:https?:\/\/\S+|(?:www\.|linkedin\.com\/|github\.com\/)\S+)/gi) || [])
      .map((u) => u.replace(/[),.;]+$/, ''))
      .join(', ');
    // Only accept a line that is SHAPED like a name — 2-4 plain words, no
    // punctuation — otherwise section headings ("A Levels: Maths") slip in.
    const name =
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length <= 60 && /^[A-Za-z][A-Za-z']*(?:[ -][A-Za-z][A-Za-z']*){1,3}$/.test(l)) || '';
    return {
      name, dob: '', address: '', email, phone, links, profile: '',
      school: '', schooldates: '', gcse: '', qualifications: [], projects: [],
      quant: '', skills: '', jobs: [], responsibility: '', sport: '',
      fitness: '', awards: '', interests: '',
    };
  }

  // JobPilot plugin API: deterministic text extraction only — no model call, no
  // licence gate (it costs nothing and stores nothing). CORS is open because the
  // JobPilot PWA calls this from its own origin; the file never leaves memory.
  app.options('/api/extract-text', (req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.sendStatus(204);
  });
  app.post('/api/extract-text', upload.single('file'), async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (!req.file) {
      logEvent('extract-text', 400);
      return res.status(400).json({ error: 'Send a PDF, DOCX or text file as "file".' });
    }
    try {
      const text = await extractFileText(req.file);
      if (!text.trim()) {
        logEvent('extract-text', 422);
        return res.status(422).json({ error: 'No readable text found in that file.' });
      }
      logEvent('extract-text', 200);
      res.json({ text });
    } catch (err) {
      logEvent('extract-text', err.status || 400);
      res
        .status(err.status || 400)
        .json({ error: err.status ? err.message : 'Could not read that file. Upload a PDF, DOCX or plain-text CV.' });
    }
  });
  // CV import is two-tier: without a licence (or without a server API key)
  // it's a FREE deterministic import — regex pulls the contact details, no
  // model call, no cost. A valid licence upgrades it to full AI extraction.
  app.post('/api/import-cv', upload.single('file'), express.json({ limit: '1mb' }), async (req, res) => {
    let text = '';
    try {
      if (req.file) {
        text = await extractFileText(req.file);
      } else if (req.body && typeof req.body.text === 'string') {
        text = req.body.text;
      }
    } catch (err) {
      logEvent('import-cv', err.status || 400);
      return res
        .status(err.status || 400)
        .json({ error: err.status ? err.message : 'Could not read that file. Upload a PDF, DOCX or plain-text CV.' });
    }
    if (!text.trim()) {
      logEvent('import-cv', 400);
      return res.status(400).json({ error: 'Upload a PDF, DOCX or text file (or send "text") containing your CV.' });
    }

    const filename = req.file ? req.file.originalname || '' : '';
    const access = await licensing.checkAccess(req);
    const client = access.allowed ? getAnthropic() : null;

    if (!access.allowed || !client) {
      // Free tier (or no API key configured): fill what regex can find with
      // certainty and say so — ai:false lets the UI explain; upgrade:true
      // tells it a paid licence would have done the full AI import.
      const extracted = basicExtract(text);
      if (!extracted.name) extracted.name = nameFromFilename(filename);
      logEvent('import-cv', 200);
      return res.json({
        result: JSON.stringify(extracted),
        beta: !!access.beta,
        ai: false,
        ...(access.allowed ? {} : { upgrade: true, checkoutUrl: config.checkoutUrl }),
      });
    }

    // Paid tier: AI extraction, drawing from the same hourly bucket as the
    // other AI routes.
    const bucket = access.beta ? `ip:${req.ip}` : `key:${access.licenseKey}`;
    const limit = access.beta ? config.betaRateLimit : config.paidRateLimit;
    if (!rateLimiter.allow(bucket, limit)) {
      logEvent('import-cv', 429);
      return res.status(429).json({
        error: `Rate limit reached (${limit} generations per hour). Please try again later.`,
        beta: !!access.beta,
      });
    }
    // import-cv doesn't route through gateAIRequest (it has its own two-tier
    // free/paid gate above), so the monthly cap is applied here directly.
    if (checkMonthlyLimit(access, req, res, 'import-cv')) return;

    try {
      let result = await extractCV(client, text.slice(0, 15000), filename);
      // Safety net: if the model left name empty but the filename carries it,
      // backfill deterministically rather than losing it. Structured outputs
      // guarantee valid JSON now, so this parses directly -- no code-fence
      // stripping needed.
      try {
        const obj = JSON.parse(result);
        if (obj && typeof obj === 'object' && !obj.name) {
          const fromFile = nameFromFilename(filename);
          if (fromFile) {
            obj.name = fromFile;
            result = JSON.stringify(obj);
          }
        }
      } catch {
        // non-JSON model output: hand it to the client's tolerant parser as-is
      }
      logEvent('import-cv', 200);
      res.json({ result, beta: !!access.beta, ai: true });
    } catch (err) {
      if (handleModelError(err, res, 'import-cv')) return;
      logEvent('import-cv', 502);
      res.status(502).json({ error: 'Import failed. Please try again in a moment.' });
    }
  });

  // Job-advert fetch: pulls a job posting's page server-side (the browser can't,
  // because of CORS) and strips it to plain text for the tailoring step. No model
  // call and no licence gate, but rate-limited so it can't be used as an open
  // proxy — and never pointed at private/internal addresses.
  const jobFetch = options.jobFetch || fetch;
  function isBlockedHost(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
    if (h.includes(':')) return true; // IPv6 literals — refuse outright
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return true;
    }
    return false;
  }
  app.post('/api/fetch-job', express.json({ limit: '10kb' }), async (req, res) => {
    if (!rateLimiter.allow(`fetchjob:${req.ip}`, 30)) {
      logEvent('fetch-job', 429);
      return res.status(429).json({ error: 'Too many link fetches this hour — paste the job description in instead.' });
    }
    let url;
    try {
      url = new URL(String((req.body && req.body.url) || '').trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      logEvent('fetch-job', 400);
      return res.status(400).json({ error: 'Send a full job-advert link starting with http:// or https://.' });
    }
    if (isBlockedHost(url.hostname)) {
      logEvent('fetch-job', 400);
      return res.status(400).json({ error: 'That address cannot be fetched — use a public job-advert link.' });
    }
    try {
      // redirect: 'manual' + a hop loop that re-runs isBlockedHost() on every
      // redirect target, not just the original URL. A 3xx response is
      // otherwise followed transparently (Node's fetch defaults to
      // redirect: 'follow'), which would let a public URL redirect the
      // server into fetching an internal/metadata address (SSRF) — the
      // original isBlockedHost() check above only ever saw the URL the user
      // supplied, never where a redirect actually led.
      const MAX_REDIRECTS = 5;
      let currentUrl = url;
      let resp;
      for (let hop = 0; ; hop++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          resp = await jobFetch(currentUrl.href, {
            signal: controller.signal,
            redirect: 'manual',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CV-Builder job fetch)', Accept: 'text/html,*/*' },
          });
        } finally {
          clearTimeout(timer);
        }
        const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null;
        if (!location) break;
        if (hop >= MAX_REDIRECTS) {
          logEvent('fetch-job', 400);
          return res.status(400).json({ error: 'That address cannot be fetched — use a public job-advert link.' });
        }
        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl);
          if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') throw new Error('bad protocol');
        } catch {
          logEvent('fetch-job', 400);
          return res.status(400).json({ error: 'That address cannot be fetched — use a public job-advert link.' });
        }
        if (isBlockedHost(nextUrl.hostname)) {
          logEvent('fetch-job', 400);
          return res.status(400).json({ error: 'That address cannot be fetched — use a public job-advert link.' });
        }
        currentUrl = nextUrl;
      }
      if (!resp.ok) {
        logEvent('fetch-job', 422);
        return res.status(422).json({
          error: `That site answered with status ${resp.status} — many job boards block automated fetches. Copy the job description and paste it in instead.`,
        });
      }
      const raw = (await resp.text()).slice(0, 800000);
      const text = (/<[a-z!/][^>]*>/i.test(raw) ? htmlToText(raw) : raw).slice(0, 20000).trim();
      if (!text) {
        logEvent('fetch-job', 422);
        return res.status(422).json({ error: 'No readable text found at that link — paste the job description in instead.' });
      }
      logEvent('fetch-job', 200);
      res.json({ text });
    } catch {
      logEvent('fetch-job', 422);
      res.status(422).json({
        error: "Couldn't fetch that link (site unreachable or too slow). Copy the job description and paste it in instead.",
      });
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

module.exports = { createApp, cacheRoleCorpus };

if (require.main === module) {
  require('dotenv').config();
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(port, () => {
    const beta = (process.env.BETA_MODE ?? 'false') === 'true';
    console.log(`CV Builder listening on http://localhost:${port} (beta mode: ${beta ? 'ON — free for everyone' : 'off — AI needs a licence key'})`);
  });
}
