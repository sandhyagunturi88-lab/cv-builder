'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp } = require('../server');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHECKOUT_URL = 'https://teststore.lemonsqueezy.com/buy/abc-123';


// cv-builder.html is a single-file, no-build-step, browser-global frontend
// (by design — see DESIGN.md) with no module exports, so its pure
// qualifications-shape helpers (migrateQualifications(), gradeText(), the
// profile/facts builders, etc.) can't be require()'d directly. Instead we
// extract the <script> body up to (but not including) the first `async
// function` — everything before that point is const/function declarations
// only (confirmed by scanning for stray top-level statements), plus one
// small self-invoking IIFE that wires up the rich-text profile box and
// needs a minimal document stub to run without throwing — and evaluate it
// in a vm context, matching the same regex-extract-and-execute technique
// the system-testing pass already used to manually verify these functions.
// This deliberately reaches past migrateQualifications()/gradeText() to
// also cover profileQualificationsBase()/profileLine(), stageFactsLine(),
// defaultQualLevelForStage() and qualificationsFactsLine() — round 1's
// harness cut off before those, which is exactly how a real regression in
// qualificationsFactsLine() (round 2 finding) went undetected. None of the
// DOM-rendering frontend behaviour (render(), drawQualifications(), the AI
// fetch() calls, etc.) is exercised this way — the document stub is only
// complete enough for $()/v() field reads to work, not for real rendering.
//
// The stubbed <select id="f_stage">/<input id="f_gcse"> etc. elements are
// cached per id (unlike a naive stub that hands back a fresh element every
// call) so that setting `.value` from a test and later reading it back via
// v(id) inside the sandbox actually round-trips. `S` (the frontend's state
// object) is a `const`, so — unlike the function declarations, which do
// become sandbox properties — it is exposed separately as `sandbox.state`
// via one extra `var` statement, since `const`/`let` bindings don't attach
// to a vm context's global object the way `var`/`function` do.
let frontendHelpersCache = null;
function loadFrontendHelpers() {
  if (frontendHelpersCache) return frontendHelpersCache;
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'cv-builder.html'), 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(scriptMatch, 'cv-builder.html must contain a <script> block');
  const cutMarker = 'async function generateAI';
  const cutIdx = scriptMatch[1].indexOf(cutMarker);
  assert.ok(cutIdx > 0, 'expected an "async function generateAI" marker to still exist in cv-builder.html');
  const prefix = scriptMatch[1].slice(0, cutIdx);

  const fakeElement = () => {
    const el = {
      innerHTML: '', textContent: '', style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
      setAttribute() {}, getAttribute() { return null; }, appendChild() {}, querySelectorAll() { return []; },
    };
    let value = '';
    Object.defineProperty(el, 'value', { get: () => value, set: (v) => { value = v; }, configurable: true });
    return el;
  };
  const elementsById = new Map();
  const sandbox = {
    document: {
      getElementById: (id) => {
        if (!elementsById.has(id)) elementsById.set(id, fakeElement());
        return elementsById.get(id);
      },
      createElement: () => fakeElement(),
      addEventListener() {},
      execCommand() {},
      activeElement: null,
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(prefix, sandbox);
  // `S` is declared with `const`, so expose a live reference to it under a
  // `var` binding, which — unlike `const`/`let` — does attach to the vm
  // context's global object and is therefore visible as sandbox.state.
  vm.runInContext('var __testStateRef = S;', sandbox);
  sandbox.state = sandbox.__testStateRef;
  // Convenience for tests: set a stubbed field's value (e.g. "f_gcse",
  // "f_stage") the same way a user typing into the real form would.
  sandbox.setField = (id, value) => { sandbox.document.getElementById(id).value = value; };
  frontendHelpersCache = sandbox;
  return sandbox;
}

function stubAnthropic() {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: 'GENERATED CV TEXT' }], stop_reason: 'end_turn' }),
    },
  };
}

async function startApp(options) {
  const app = createApp({ checkoutUrl: CHECKOUT_URL, anthropic: stubAnthropic(), ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function postGenerate(base, headers = {}) {
  return fetch(`${base}/api/generate-cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ facts: 'Name: Sam | A Levels: Maths' }),
  });
}

test('beta mode allows generation without a license key', async (t) => {
  const { server, base } = await startApp({ betaMode: true });
  t.after(() => server.close());

  const resp = await postGenerate(base);
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.result, 'GENERATED CV TEXT');
  assert.equal(data.beta, true);
});

test('non-beta without a key returns 402 including checkoutUrl', async (t) => {
  const { server, base } = await startApp({ betaMode: false });
  t.after(() => server.close());

  const resp = await postGenerate(base);
  assert.equal(resp.status, 402);
  const data = await resp.json();
  assert.ok(data.error);
  assert.equal(data.checkoutUrl, CHECKOUT_URL);
});

test('non-beta with a valid key returns 200 and caches the validation', async (t) => {
  let validateCalls = 0;
  const lsFetch = async () => {
    validateCalls++;
    return { ok: true, json: async () => ({ valid: true, license_key: { status: 'active' } }) };
  };
  const { server, base } = await startApp({ betaMode: false, lsFetch });
  t.after(() => server.close());

  const resp1 = await postGenerate(base, { 'X-License-Key': 'valid-key-1' });
  assert.equal(resp1.status, 200);
  const data = await resp1.json();
  assert.equal(data.result, 'GENERATED CV TEXT');
  assert.equal(data.beta, false);

  const resp2 = await postGenerate(base, { 'X-License-Key': 'valid-key-1' });
  assert.equal(resp2.status, 200);
  assert.equal(validateCalls, 1, 'second request should be served from the 10-minute cache');
});

test('non-beta with an invalid key returns 402 including checkoutUrl', async (t) => {
  const lsFetch = async () => ({ ok: true, json: async () => ({ valid: false, error: 'license_key not found' }) });
  const { server, base } = await startApp({ betaMode: false, lsFetch });
  t.after(() => server.close());

  const resp = await postGenerate(base, { 'X-License-Key': 'bogus-key' });
  assert.equal(resp.status, 402);
  const data = await resp.json();
  assert.equal(data.checkoutUrl, CHECKOUT_URL);
});

test('webhook with a bad signature returns 401', async (t) => {
  const { server, base } = await startApp({ betaMode: true, webhookSecret: 'whsec-test' });
  t.after(() => server.close());

  const resp = await fetch(`${base}/api/ls-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': 'not-the-right-signature' },
    body: JSON.stringify({ meta: { event_name: 'subscription_cancelled' } }),
  });
  assert.equal(resp.status, 401);
});

test('webhook with a valid signature evicts the key from the license cache', async (t) => {
  const secret = 'whsec-test';
  let validateCalls = 0;
  const lsFetch = async () => {
    validateCalls++;
    return { ok: true, json: async () => ({ valid: true, license_key: { status: 'active' } }) };
  };
  const { server, base } = await startApp({ betaMode: false, webhookSecret: secret, lsFetch });
  t.after(() => server.close());

  // Prime the cache
  assert.equal((await postGenerate(base, { 'X-License-Key': 'key-abc' })).status, 200);
  assert.equal(validateCalls, 1);

  // Signed license_key_updated event for that key
  const body = JSON.stringify({
    meta: { event_name: 'license_key_updated' },
    data: { attributes: { key: 'key-abc' } },
  });
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const hook = await fetch(`${base}/api/ls-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
    body,
  });
  assert.equal(hook.status, 200);

  // Next request must re-validate (cache entry evicted)
  assert.equal((await postGenerate(base, { 'X-License-Key': 'key-abc' })).status, 200);
  assert.equal(validateCalls, 2);
});

test('beta rate limit returns 429 after the cap', async (t) => {
  const { server, base } = await startApp({ betaMode: true, betaRateLimit: 10 });
  t.after(() => server.close());

  for (let i = 0; i < 10; i++) {
    assert.equal((await postGenerate(base)).status, 200, `request ${i + 1} should succeed`);
  }
  const over = await postGenerate(base);
  assert.equal(over.status, 429);
  const data = await over.json();
  assert.match(data.error, /rate limit/i);
});

test('a custom payment provider can replace Lemon Squeezy via the provider interface', async (t) => {
  // Minimal stand-in for e.g. Dodo Payments or Paddle — only the interface matters.
  const evicted = [];
  const customProvider = {
    name: 'stub-pay',
    validateKey: async (key) => key === 'dodo-good-key',
    verifyWebhook: (rawBody, getHeader) => getHeader('X-Stub-Auth') === 'letmein',
    parseWebhook: (payload) => {
      if (payload.kind === 'cancelled') {
        evicted.push(payload.key);
        return { action: 'revoke_key', key: payload.key };
      }
      return { action: 'ignore' };
    },
  };
  const { server, base } = await startApp({ betaMode: false, provider: customProvider });
  t.after(() => server.close());

  assert.equal((await postGenerate(base, { 'X-License-Key': 'dodo-good-key' })).status, 200);
  assert.equal((await postGenerate(base, { 'X-License-Key': 'wrong-key' })).status, 402);

  // Webhook uses the custom provider's own auth scheme and event shape
  const badHook = await fetch(`${base}/api/payments-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'cancelled', key: 'dodo-good-key' }),
  });
  assert.equal(badHook.status, 401);

  const goodHook = await fetch(`${base}/api/payments-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Stub-Auth': 'letmein' },
    body: JSON.stringify({ kind: 'cancelled', key: 'dodo-good-key' }),
  });
  assert.equal(goodHook.status, 200);
  assert.deepEqual(evicted, ['dodo-good-key']);
});

test('suggest endpoint follows the same access rules and shares the rate-limit bucket', async (t) => {
  const postSuggest = (base, headers = {}) =>
    fetch(`${base}/api/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ context: 'Target role: Retail / customer service' }),
    });

  // Beta: allowed without a key
  const beta = await startApp({ betaMode: true, betaRateLimit: 3 });
  t.after(() => beta.server.close());
  const ok = await postSuggest(beta.base);
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.result, 'GENERATED CV TEXT');
  assert.equal(data.beta, true);

  // Generations and suggestions drain the same hourly bucket
  assert.equal((await postGenerate(beta.base)).status, 200);
  assert.equal((await postGenerate(beta.base)).status, 200);
  assert.equal((await postSuggest(beta.base)).status, 429);

  // Non-beta: no key -> 402 with checkoutUrl
  const paid = await startApp({ betaMode: false });
  t.after(() => paid.server.close());
  const denied = await postSuggest(paid.base);
  assert.equal(denied.status, 402);
  assert.equal((await denied.json()).checkoutUrl, CHECKOUT_URL);
});

test('polish endpoint validates the category and returns the model output', async (t) => {
  const { server, base } = await startApp({ betaMode: true });
  t.after(() => server.close());

  const ok = await fetch(`${base}/api/polish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'skill', text: 'used excel for a school stall', target: 'Retail' }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result, 'GENERATED CV TEXT');

  // step 4/5 categories are accepted too
  const job = await fetch(`${base}/api/polish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'job', text: 'helped at parkrun scanning barcodes' }),
  });
  assert.equal(job.status, 200);

  const bad = await fetch(`${base}/api/polish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'nonsense', text: 'x' }),
  });
  assert.equal(bad.status, 400);
});

test('import-cv endpoint accepts text and rejects empty input', async (t) => {
  const { server, base } = await startApp({ betaMode: true });
  t.after(() => server.close());

  const ok = await fetch(`${base}/api/import-cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Sam Example\nLeeds\nA Levels: Maths (A)' }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result, 'GENERATED CV TEXT');

  // multipart upload path (plain-text file)
  const fd = new FormData();
  fd.append('file', new Blob(['Sam Example\nCV text'], { type: 'text/plain' }), 'cv.txt');
  const up = await fetch(`${base}/api/import-cv`, { method: 'POST', body: fd });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).result, 'GENERATED CV TEXT');

  const empty = await fetch(`${base}/api/import-cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);
});

test('import-cv without a licence does a free no-AI import instead of a 402', async (t) => {
  // Paid-only mode, no key sent: every other AI route 402s, but import-cv
  // downgrades to the free deterministic extraction (no model call, no cost).
  const lsFetch = async () => ({ ok: true, json: async () => ({ valid: false }) });
  const { server, base } = await startApp({ betaMode: false, lsFetch });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/import-cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Sam Example\nLeeds\nsam@example.com · 07700 900123\nA Levels: Maths (A)',
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai, false);
  assert.equal(data.upgrade, true);
  assert.equal(data.checkoutUrl, CHECKOUT_URL);
  const obj = JSON.parse(data.result);
  assert.equal(obj.name, 'Sam Example');
  assert.equal(obj.email, 'sam@example.com');
  assert.equal(obj.school, ''); // nothing guessed — free tier fills only certainties

  // A valid licence key still gets the full AI import
  const lsOk = async () => ({ ok: true, json: async () => ({ valid: true, license_key: { status: 'active' } }) });
  const paid = await startApp({ betaMode: false, lsFetch: lsOk });
  t.after(() => paid.server.close());
  const aiRes = await fetch(`${paid.base}/api/import-cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-License-Key': 'valid-key' },
    body: JSON.stringify({ text: 'Sam Example\nLeeds\nA Levels: Maths (A)' }),
  });
  assert.equal(aiRes.status, 200);
  const aiData = await aiRes.json();
  assert.equal(aiData.result, 'GENERATED CV TEXT');
  assert.equal(aiData.ai, true);
});

test('import-cv without an API key falls back to no-AI contact extraction', async (t) => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });

  const { server, base } = await startApp({ betaMode: true, anthropic: null });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/import-cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Sam Example\nLeeds\nsam@example.com · 07700 900123\nlinkedin.com/in/samexample\nA Levels: Maths (A)',
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai, false);
  const obj = JSON.parse(data.result);
  assert.equal(obj.name, 'Sam Example');
  assert.equal(obj.email, 'sam@example.com');
  assert.equal(obj.phone, '07700 900123');
  assert.match(obj.links, /linkedin\.com\/in\/samexample/);
  assert.equal(obj.school, ''); // nothing guessed beyond what regex can prove
});

test('import-cv derives the name from the filename when the CV text lacks it', async (t) => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });

  const { server, base } = await startApp({ betaMode: true, anthropic: null });
  t.after(() => server.close());

  // Names commonly live in a Word header that text extraction can't see —
  // but the file itself is named after its owner.
  const fd = new FormData();
  fd.append(
    'file',
    new Blob(['Contact: jane@example.com\nA Levels: Maths (A)'], { type: 'text/plain' }),
    'Jane Smith_CV.txt',
  );
  const res = await fetch(`${base}/api/import-cv`, { method: 'POST', body: fd });
  assert.equal(res.status, 200);
  const obj = JSON.parse((await res.json()).result);
  assert.equal(obj.name, 'Jane Smith');

  // ...but gibberish filenames must not become names
  const fd2 = new FormData();
  fd2.append('file', new Blob(['jane@example.com'], { type: 'text/plain' }), 'scan_2024_01.txt');
  const obj2 = JSON.parse((await (await fetch(`${base}/api/import-cv`, { method: 'POST', body: fd2 })).json()).result);
  assert.equal(obj2.name, '');
});

test('extract-text (JobPilot plugin API) returns raw text with CORS, no licence gate', async (t) => {
  // betaMode false + no key: AI routes would 402, but extract-text is
  // deterministic (no model call, no cost) so it stays open.
  const lsFetch = async () => ({ ok: true, json: async () => ({ valid: false }) });
  const { server, base } = await startApp({ betaMode: false, lsFetch });
  t.after(() => server.close());

  const fd = new FormData();
  fd.append('file', new Blob(['Sam Example\nLeeds\nA Levels: Maths (A)'], { type: 'text/plain' }), 'cv.txt');
  const ok = await fetch(`${base}/api/extract-text`, { method: 'POST', body: fd });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.match((await ok.json()).text, /Sam Example/);

  const missing = await fetch(`${base}/api/extract-text`, { method: 'POST' });
  assert.equal(missing.status, 400);

  const preflight = await fetch(`${base}/api/extract-text`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});

// Builds a stored (uncompressed) ZIP the same way the client's exportWord()
// does, so this fixture is byte-layout-faithful to our real .docx download.
function storedZip(entries) {
  const crc32 = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunks = [];
  const central = [];
  let off = 0;
  for (const [name, text] of entries) {
    const nb = Buffer.from(name);
    const db = Buffer.from(text);
    const crc = crc32(db);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(db.length, 18);
    lh.writeUInt32LE(db.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    chunks.push(lh, nb, db);
    central.push([nb, crc, db.length, off]);
    off += 30 + nb.length + db.length;
  }
  let cdSize = 0;
  for (const [nb, crc, len, o] of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(len, 20);
    ch.writeUInt32LE(len, 24);
    ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(o, 42);
    chunks.push(ch, nb);
    cdSize += 46 + nb.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(off, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

test('a .docx built like our Word export round-trips back to clean text', async (t) => {
  const { server, base } = await startApp({ betaMode: true });
  t.after(() => server.close());

  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const p = (text, bold) =>
    `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const docx = storedZip([
    ['[Content_Types].xml', XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', XML +
      `<w:document ${W}><w:body>` +
      p('Sam Tidman', true) +
      p('Swansea   ·   samtids@hotmail.com') +
      p('Education', true) +
      p('A Levels: Mathematics &amp; Statistics — A*') +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'],
  ]);
  const fd = new FormData();
  fd.append(
    'file',
    new Blob([docx], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    'sam-tidman-cv.docx',
  );
  const res = await fetch(`${base}/api/extract-text`, { method: 'POST', body: fd });
  assert.equal(res.status, 200);
  const { text } = await res.json();
  assert.match(text, /Sam Tidman/);
  assert.match(text, /samtids@hotmail\.com/);
  assert.match(text, /Mathematics & Statistics/);
});

test('a legacy .doc from the old HTML Word export still round-trips back to clean text', async (t) => {
  const { server, base } = await startApp({ betaMode: true });
  t.after(() => server.close());

  // Shape of the old exportWord()'s output: BOM + Word-HTML wrapper around the CV.
  const exported =
    '﻿<html xmlns:o=\'urn:schemas-microsoft-com:office:office\' ' +
    "xmlns:w='urn:schemas-microsoft-com:office:word'><head><meta charset='utf-8'>" +
    '<title>CV</title><style>@page{size:A4;} .cv-name{font-size:26px;}</style></head><body>' +
    '<div class="cv-header"><div class="cv-name">Sam Tidman</div>' +
    '<div class="cv-contact">Swansea   ·   samtids@hotmail.com</div></div>' +
    '<div class="cv-sec-block"><h3 class="cv-sec">Education</h3>' +
    '<div class="grades-line"><b>A Levels:</b> Mathematics &amp; Statistics — A*</div></div>' +
    '<ul><li>Played football at junior level</li></ul></body></html>';
  const fd = new FormData();
  fd.append('file', new Blob([exported], { type: 'application/msword' }), 'sam-tidman-cv.doc');
  const res = await fetch(`${base}/api/extract-text`, { method: 'POST', body: fd });
  assert.equal(res.status, 200);
  const { text } = await res.json();
  assert.match(text, /Sam Tidman/);
  assert.match(text, /samtids@hotmail\.com/);
  assert.match(text, /Mathematics & Statistics/);
  assert.doesNotMatch(text, /<|@page|cv-name/); // no tags or CSS leak through
});

test('legacy binary .doc is rejected with a clear save-as message', async (t) => {
  const { server, base } = await startApp({ betaMode: true });
  t.after(() => server.close());

  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
  const fd = new FormData();
  fd.append('file', new Blob([ole], { type: 'application/msword' }), 'old-cv.doc');
  const res = await fetch(`${base}/api/extract-text`, { method: 'POST', body: fd });
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /save as .docx or PDF/i);
});

test('tailor endpoint follows the AI access rules and validates its input', async (t) => {
  const postTailor = (base, body) =>
    fetch(`${base}/api/tailor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const beta = await startApp({ betaMode: true });
  t.after(() => beta.server.close());

  const ok = await postTailor(beta.base, { job: 'Trainee accountant. Excel required.', facts: 'Skills: Excel, Python' });
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.result, 'GENERATED CV TEXT');
  assert.equal(data.beta, true);

  assert.equal((await postTailor(beta.base, { job: 'advert only' })).status, 400);
  assert.equal((await postTailor(beta.base, { facts: 'facts only' })).status, 400);

  // Non-beta without a key: 402 like every other AI route
  const paid = await startApp({ betaMode: false });
  t.after(() => paid.server.close());
  const denied = await postTailor(paid.base, { job: 'x', facts: 'y' });
  assert.equal(denied.status, 402);
  assert.equal((await denied.json()).checkoutUrl, CHECKOUT_URL);
});

test('fetch-job strips a fetched advert page to text', async (t) => {
  let fetchedUrl = null;
  const jobFetch = async (url) => {
    fetchedUrl = url;
    return {
      ok: true,
      text: async () =>
        '<html><head><style>.x{color:red}</style><title>Job</title></head><body>' +
        '<h1>Trainee Data Analyst</h1><p>We need Excel &amp; SQL.</p><script>track()</script></body></html>',
    };
  };
  const { server, base } = await startApp({ betaMode: true, jobFetch });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/fetch-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://jobs.example.com/trainee-analyst' }),
  });
  assert.equal(res.status, 200);
  const { text } = await res.json();
  assert.equal(fetchedUrl, 'https://jobs.example.com/trainee-analyst');
  assert.match(text, /Trainee Data Analyst/);
  assert.match(text, /Excel & SQL/);
  assert.doesNotMatch(text, /<|color:red|track\(\)/); // no tags, CSS or JS leak through
});

test('fetch-job rejects invalid and private-network URLs', async (t) => {
  const jobFetch = async () => {
    throw new Error('must never be called for a rejected URL');
  };
  const { server, base } = await startApp({ betaMode: true, jobFetch });
  t.after(() => server.close());

  const post = (url) =>
    fetch(`${base}/api/fetch-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

  assert.equal((await post('')).status, 400);
  assert.equal((await post('not a url')).status, 400);
  assert.equal((await post('ftp://example.com/job')).status, 400);
  for (const blocked of [
    'http://localhost/admin',
    'http://127.0.0.1:3000/',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x',
    'http://server.internal/x',
  ]) {
    assert.equal((await post(blocked)).status, 400, `${blocked} must be refused`);
  }
});

test('fetch-job turns an upstream error status into a paste-it-instead message', async (t) => {
  const jobFetch = async () => ({ ok: false, status: 403, text: async () => '' });
  const { server, base } = await startApp({ betaMode: true, jobFetch });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/fetch-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://jobs.example.com/blocked' }),
  });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /paste it in instead/i);
});

// SSRF regression: a public URL that 3xx-redirects to an internal/metadata
// address must never actually be fetched. Security-review finding: the
// original isBlockedHost() check only ever ran against the user-supplied
// URL, and the fetch had no `redirect` option (Node defaults to "follow"),
// so the server would transparently follow a redirect into e.g.
// 169.254.169.254 (cloud metadata) or 127.0.0.1 and return its contents.
test('fetch-job refuses to follow a redirect into a blocked internal/metadata address', async (t) => {
  let fetchCalls = 0;
  const jobFetch = async (url, opts) => {
    fetchCalls++;
    assert.equal(opts.redirect, 'manual', 'must fetch with redirect: "manual" so 3xx responses can be inspected before following');
    return {
      status: 302,
      ok: false,
      headers: { get: (name) => (name.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null) },
      text: async () => '',
    };
  };
  const { server, base } = await startApp({ betaMode: true, jobFetch });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/fetch-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://jobs.example.com/redirects-to-metadata' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /cannot be fetched/i);
  assert.equal(fetchCalls, 1, 'the blocked redirect target must never actually be fetched');
});

test('fetch-job refuses to follow a redirect into localhost', async (t) => {
  const jobFetch = async () => ({
    status: 302,
    ok: false,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? 'http://127.0.0.1:8080/admin' : null) },
    text: async () => '',
  });
  const { server, base } = await startApp({ betaMode: true, jobFetch });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/fetch-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://jobs.example.com/redirects-to-localhost' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /cannot be fetched/i);
});

test('fetch-job follows a redirect to another public URL', async (t) => {
  const fetchedUrls = [];
  const jobFetch = async (url) => {
    fetchedUrls.push(url);
    if (url === 'https://jobs.example.com/old-link') {
      return {
        status: 301,
        ok: false,
        headers: { get: (name) => (name.toLowerCase() === 'location' ? 'https://jobs.example.com/new-link' : null) },
        text: async () => '',
      };
    }
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => '<html><body><h1>Trainee Data Analyst</h1></body></html>',
    };
  };
  const { server, base } = await startApp({ betaMode: true, jobFetch });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/fetch-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://jobs.example.com/old-link' }),
  });
  assert.equal(res.status, 200);
  const { text } = await res.json();
  assert.match(text, /Trainee Data Analyst/);
  assert.deepEqual(fetchedUrls, ['https://jobs.example.com/old-link', 'https://jobs.example.com/new-link']);
});

test('fetch-job gives up after too many redirect hops instead of looping forever', async (t) => {
  let fetchCalls = 0;
  const jobFetch = async (url) => {
    fetchCalls++;
    const n = Number(new URL(url).pathname.replace('/hop', '')) || 0;
    return {
      status: 302,
      ok: false,
      headers: { get: (name) => (name.toLowerCase() === 'location' ? `https://jobs.example.com/hop${n + 1}` : null) },
      text: async () => '',
    };
  };
  const { server, base } = await startApp({ betaMode: true, jobFetch });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/fetch-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://jobs.example.com/hop0' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /cannot be fetched/i);
  assert.equal(fetchCalls, 6, 'the initial fetch plus 5 redirect hops, then it gives up');
});

test('prompts carry the XYZ formula with the no-invented-numbers rule', () => {
  const { SYSTEM_PROMPT, POLISH_PROMPT } = require('../lib/anthropic');
  assert.match(SYSTEM_PROMPT, /as measured by Y, by doing Z/);
  assert.match(SYSTEM_PROMPT, /[Nn]ever invent/);
  assert.match(POLISH_PROMPT, /as measured by Y, by doing Z/);
  assert.match(POLISH_PROMPT, /never invent one/);
});

function jsonStub(obj) {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn' }),
    },
  };
}

const DIAGNOSIS = {
  score: 62,
  summary: 'Parses, but weak on dates and skills.',
  flags: [
    { section: 'Education', severity: 'high', problem: 'No dates', fix: 'Add start and end years.' },
    { section: 'Skills', severity: 'medium', problem: 'Vague', fix: 'Name concrete tools.' },
    { section: 'Profile', severity: 'low', problem: 'No keywords', fix: 'Name the target role.' },
  ],
};

test('diagnose returns the full report for licensed users', async (t) => {
  const { server, base } = await startApp({ betaMode: true, anthropic: jsonStub(DIAGNOSIS) });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/diagnose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Sam Example\nA Levels: Maths (A)' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.result.score, 62);
  assert.equal(data.result.flags.length, 3);
  assert.equal(data.locked, 0);

  const empty = await fetch(`${base}/api/diagnose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);
});

test('diagnose free tier is deterministic — zero model calls, score + one flag, daily cap', async (t) => {
  let modelCalls = 0;
  const countingStub = {
    messages: { create: async () => { modelCalls++; return { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' }; } },
  };
  const lsFetch = async () => ({ ok: true, json: async () => ({ valid: false }) });
  const { server, base } = await startApp({
    betaMode: false,
    lsFetch,
    anthropic: countingStub,
    freeDiagnoseLimit: 2,
  });
  t.after(() => server.close());

  const post = () =>
    fetch(`${base}/api/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // no email, no phone, no dates → the heuristics must flag it
      body: JSON.stringify({ text: 'Sam Example\nA Levels: Maths (A)' }),
    });

  const res = await post();
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai, false, 'free tier is the no-AI heuristic check');
  assert.equal(typeof data.result.score, 'number');
  assert.ok(data.result.score < 100, 'a CV with no contact details cannot score 100');
  assert.equal(data.result.flags.length, 1, 'free tier shows only the worst flag');
  assert.equal(data.result.flags[0].severity, 'high', 'worst flag first (missing email/dates)');
  assert.ok(data.locked >= 1, 'remaining flags are advertised as locked');
  assert.equal(data.upgrade, true);
  assert.equal(data.checkoutUrl, CHECKOUT_URL);

  assert.equal((await post()).status, 200);
  const over = await post();
  assert.equal(over.status, 429, 'third free check of the day is refused');
  assert.equal((await over.json()).checkoutUrl, CHECKOUT_URL);
  assert.equal(modelCalls, 0, 'the free tier must NEVER call the model');
});

test('diagnose turns unparseable model output into a 502', async (t) => {
  const { server, base } = await startApp({ betaMode: true }); // default stub returns non-JSON
  t.after(() => server.close());

  const res = await fetch(`${base}/api/diagnose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Sam Example' }),
  });
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(await res.json()), /GENERATED CV TEXT/, 'no model output leaks');
});

test('keyword gap is hidden without JOBPILOT_API_URL and served with it', async (t) => {
  // Standalone deploy: feature flag off, route unavailable
  const bare = await startApp({ betaMode: true });
  t.after(() => bare.server.close());
  assert.deepEqual(await (await fetch(`${bare.base}/api/features`)).json(), { keywordGap: false, beta: true, checkoutUrl: 'https://teststore.lemonsqueezy.com/buy/abc-123' });
  const off = await fetch(`${bare.base}/api/keyword-gap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'accounting', facts: 'Skills: Excel' }),
  });
  assert.equal(off.status, 503);

  // Configured deploy: corpus fetched from the JobPilot API, model diffs it
  const GAP = {
    in_demand: [{ keyword: 'Excel', seen_in: 12 }, { keyword: 'AAT', seen_in: 7 }],
    matched: [{ keyword: 'Excel', evidence: 'Used Excel for school stall accounts' }],
    missing: [{ keyword: 'AAT', why_it_matters: 'Common entry qualification', how_to_get_it: 'Look at AAT Level 2' }],
  };
  let corpusUrl = null;
  let corpusAuth = null;
  const corpusFetch = async (url, opts) => {
    corpusUrl = url;
    corpusAuth = opts.headers.Authorization;
    return {
      ok: true,
      json: async () => ({ jobs: [{ title: 'Trainee Accountant', jd_text: 'Excel and AAT required' }] }),
    };
  };
  const on = await startApp({
    betaMode: true,
    anthropic: jsonStub(GAP),
    jobpilotApiUrl: 'https://api.jobpilot.example',
    jobpilotApiToken: 'secret-token',
    corpusFetch,
  });
  t.after(() => on.server.close());
  assert.deepEqual(await (await fetch(`${on.base}/api/features`)).json(), { keywordGap: true, beta: true, checkoutUrl: 'https://teststore.lemonsqueezy.com/buy/abc-123' });

  const res = await fetch(`${on.base}/api/keyword-gap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'accounting', facts: 'Skills: Excel' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.result.missing[0].keyword, 'AAT');
  assert.equal(data.adverts, 1);
  assert.match(corpusUrl, /\/api\/v1\/jobs\/role-corpus\?role=accounting&limit=40$/);
  assert.equal(corpusAuth, 'Bearer secret-token');
});

test('keyword gap degrades cleanly when the JobPilot API is down or empty', async (t) => {
  const down = await startApp({
    betaMode: true,
    anthropic: jsonStub({}),
    jobpilotApiUrl: 'https://api.jobpilot.example',
    corpusFetch: async () => { throw new Error('unreachable'); },
  });
  t.after(() => down.server.close());
  const res = await fetch(`${down.base}/api/keyword-gap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'accounting', facts: 'Skills: Excel' }),
  });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /try again/i);

  const empty = await startApp({
    betaMode: true,
    anthropic: jsonStub({}),
    jobpilotApiUrl: 'https://api.jobpilot.example',
    corpusFetch: async () => ({ ok: true, json: async () => ({ jobs: [] }) }),
  });
  t.after(() => empty.server.close());
  const none = await fetch(`${empty.base}/api/keyword-gap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'zzz', facts: 'Skills: Excel' }),
  });
  assert.equal(none.status, 422);

  // Licence rules match every other AI route
  const paid = await startApp({ betaMode: false, jobpilotApiUrl: 'https://api.jobpilot.example' });
  t.after(() => paid.server.close());
  const denied = await fetch(`${paid.base}/api/keyword-gap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'accounting', facts: 'Skills: Excel' }),
  });
  assert.equal(denied.status, 402);
});

test('interview runs on the interview model and passes the transcript through', async (t) => {
  const seen = [];
  const stub = {
    messages: {
      create: async (params) => {
        seen.push(params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ rating: 7, feedback: 'Good detail.', done: false, next_question: 'Why this role?' }),
          }],
          stop_reason: 'end_turn',
        };
      },
    },
  };
  const { server, base } = await startApp({ betaMode: true, anthropic: stub });
  t.after(() => server.close());

  const transcript = [
    { role: 'assistant', content: '{"next_question":"Tell me about yourself."}' },
    { role: 'user', content: 'I am doing A Level Maths and run a football stall.' },
  ];
  const res = await fetch(`${base}/api/interview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'Trainee accountant', facts: 'A Levels: Maths', transcript }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.result.rating, 7);
  assert.equal(data.result.next_question, 'Why this role?');

  const { INTERVIEW_PROMPT } = require('../lib/anthropic');
  assert.equal(seen[0].model, 'claude-sonnet-5', 'interviews run on the cheaper interview model');
  assert.equal(seen[0].output_config.effort, 'low');
  assert.equal(seen[0].system, INTERVIEW_PROMPT);
  assert.match(seen[0].messages[0].content, /TARGET ROLE: Trainee accountant/);
  // Transcript passes through verbatim except the last message, which is
  // marked for prompt caching: a content-block array with cache_control
  // instead of a bare string (see lib/anthropic.js's interviewTurn).
  const sentTranscript = seen[0].messages.slice(1);
  assert.deepEqual(sentTranscript.slice(0, -1), transcript.slice(0, -1), 'earlier transcript turns pass through verbatim');
  const lastSent = sentTranscript[sentTranscript.length - 1];
  const lastOriginal = transcript[transcript.length - 1];
  assert.equal(lastSent.role, lastOriginal.role);
  assert.deepEqual(lastSent.content, [
    { type: 'text', text: lastOriginal.content, cache_control: { type: 'ephemeral' } },
  ], 'the last transcript turn is cached');

  const bad = await fetch(`${base}/api/interview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'Trainee accountant' }),
  });
  assert.equal(bad.status, 400);
});

test('interview has its own buckets: generations unaffected, sessions capped per day', async (t) => {
  const FINAL = {
    rating: 8, feedback: 'Strong close.', done: true, next_question: null,
    summary: { overall: 7, strengths: ['Maths evidence'], work_on: ['Examples', 'Detail', 'Pace'] },
  };
  const { server, base } = await startApp({
    betaMode: true,
    anthropic: jsonStub(FINAL),
    betaRateLimit: 2,
    interviewDailyLimit: 2,
  });
  t.after(() => server.close());

  const postInterview = (transcript = []) =>
    fetch(`${base}/api/interview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'Retail assistant', facts: 'GCSEs: 8', transcript }),
    });

  // Two session starts allowed…
  const first = await postInterview();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).result.summary.overall, 7, 'final-turn summary parses');
  assert.equal((await postInterview()).status, 200);
  // …a mid-session continuation doesn't count as a new session…
  const cont = await postInterview([{ role: 'assistant', content: 'q' }, { role: 'user', content: 'a' }]);
  assert.equal(cont.status, 200);
  // …but a third new session the same day is refused.
  const third = await postInterview();
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /come back tomorrow/i);

  // None of that touched the generation bucket (limit 2, still fully available)
  assert.equal((await postGenerate(base)).status, 200);
  assert.equal((await postGenerate(base)).status, 200);
  assert.equal((await postGenerate(base)).status, 429, 'generation bucket only drained by generations');
});

test('paid rate limit is keyed per license key', async (t) => {
  const lsFetch = async () => ({ ok: true, json: async () => ({ valid: true, license_key: { status: 'active' } }) });
  const { server, base } = await startApp({ betaMode: false, lsFetch, paidRateLimit: 3 });
  t.after(() => server.close());

  for (let i = 0; i < 3; i++) {
    assert.equal((await postGenerate(base, { 'X-License-Key': 'key-1' })).status, 200);
  }
  assert.equal((await postGenerate(base, { 'X-License-Key': 'key-1' })).status, 429);
  // A different key has its own bucket
  assert.equal((await postGenerate(base, { 'X-License-Key': 'key-2' })).status, 200);
});

test('stop_reason "refusal" maps to 502 with no partial model text leaked', async (t) => {
  const stub = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: 'SECRET PARTIAL OUTPUT' }],
        stop_reason: 'refusal',
      }),
    },
  };
  const { server, base } = await startApp({ betaMode: true, anthropic: stub });
  t.after(() => server.close());

  const res = await postGenerate(base);
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.error, 'The AI declined this content — edit your text and try again.');
  assert.doesNotMatch(JSON.stringify(data), /SECRET PARTIAL OUTPUT/, 'no model text leaks anywhere in the response');
});

test('stop_reason "max_tokens" maps to 502 with a too-long message', async (t) => {
  const stub = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: 'TRUNCATED HALFWAY THROUGH' }],
        stop_reason: 'max_tokens',
      }),
    },
  };
  const { server, base } = await startApp({ betaMode: true, anthropic: stub });
  t.after(() => server.close());

  const res = await postGenerate(base);
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.error, 'The response was too long — try shorter input.');
});

test('/api/generate-cv slices facts at 20000 chars before calling the model', async (t) => {
  let seenContent = null;
  const stub = {
    messages: {
      create: async (params) => {
        seenContent = params.messages[0].content;
        return { content: [{ type: 'text', text: 'GENERATED CV TEXT' }], stop_reason: 'end_turn' };
      },
    },
  };
  const { server, base } = await startApp({ betaMode: true, anthropic: stub });
  t.after(() => server.close());

  const longFacts = 'A'.repeat(25000);
  const res = await fetch(`${base}/api/generate-cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facts: longFacts }),
  });
  assert.equal(res.status, 200);
  assert.equal(seenContent.length, 20000, 'only the first 20000 chars reach the model');
  assert.equal(seenContent, 'A'.repeat(20000));
});

test('/api/suggest slices context at 20000 chars before calling the model', async (t) => {
  let seenContent = null;
  const stub = {
    messages: {
      create: async (params) => {
        seenContent = params.messages[0].content;
        return { content: [{ type: 'text', text: 'GENERATED CV TEXT' }], stop_reason: 'end_turn' };
      },
    },
  };
  const { server, base } = await startApp({ betaMode: true, anthropic: stub });
  t.after(() => server.close());

  const longContext = 'B'.repeat(25000);
  const res = await fetch(`${base}/api/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: longContext }),
  });
  assert.equal(res.status, 200);
  assert.equal(seenContent.length, 20000, 'only the first 20000 chars reach the model');
});

test('monthly AI cap returns 429 after the configured count, distinct from the hourly bucket', async (t) => {
  const { server, base } = await startApp({ betaMode: true, betaRateLimit: 100, betaMonthlyAiLimit: 2 });
  t.after(() => server.close());

  assert.equal((await postGenerate(base)).status, 200, 'call 1 within the monthly cap');
  assert.equal((await postGenerate(base)).status, 200, 'call 2 within the monthly cap');
  const over = await postGenerate(base);
  assert.equal(over.status, 429);
  const data = await over.json();
  assert.equal(data.error, "You've reached this month's AI limit.");
});

test('polish and import-cv requests include output_config with a json_schema format', async (t) => {
  const seen = [];
  const stub = {
    messages: {
      create: async (params) => {
        seen.push(params);
        return {
          content: [{ type: 'text', text: JSON.stringify({ text: 'Ran a school stall using Excel.' }) }],
          stop_reason: 'end_turn',
        };
      },
    },
  };
  const { server, base } = await startApp({ betaMode: true, anthropic: stub });
  t.after(() => server.close());

  const polishRes = await fetch(`${base}/api/polish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'skill', text: 'used excel for a school stall' }),
  });
  assert.equal(polishRes.status, 200);

  const importRes = await fetch(`${base}/api/import-cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Sam Example\nLeeds\nA Levels: Maths (A)' }),
  });
  assert.equal(importRes.status, 200);

  assert.equal(seen.length, 2, 'both routes called the model');
  for (const params of seen) {
    assert.equal(params.output_config.format.type, 'json_schema');
    assert.equal(typeof params.output_config.format.schema, 'object');
    assert.equal(params.output_config.format.schema.additionalProperties, false);
  }
});

test('generate-cv, suggest and polish use the expected per-route model and effort, with no thinking/sampling fields', async (t) => {
  const seen = [];
  const stub = {
    messages: {
      create: async (params) => {
        seen.push(params);
        return { content: [{ type: 'text', text: 'GENERATED CV TEXT' }], stop_reason: 'end_turn' };
      },
    },
  };
  const { server, base } = await startApp({ betaMode: true, anthropic: stub });
  t.after(() => server.close());

  await postGenerate(base);
  await fetch(`${base}/api/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: 'Target role: Retail' }),
  });
  await fetch(`${base}/api/polish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'skill', text: 'used excel for a school stall' }),
  });

  const [generateParams, suggestParams, polishParams] = seen;
  assert.equal(generateParams.model, 'claude-opus-5');
  assert.equal(generateParams.output_config.effort, 'medium');
  assert.equal(suggestParams.model, 'claude-sonnet-5');
  assert.equal(suggestParams.output_config.effort, 'low');
  assert.equal(polishParams.model, 'claude-sonnet-5');
  assert.equal(polishParams.output_config.effort, 'low');
  for (const params of seen) {
    assert.equal(params.temperature, undefined);
    assert.equal(params.top_p, undefined);
    assert.equal(params.top_k, undefined);
    assert.equal(params.thinking, undefined);
  }
  // generate-cv's system prompt is cached; the other two routes' aren't.
  assert.ok(Array.isArray(generateParams.system));
  assert.deepEqual(generateParams.system[0].cache_control, { type: 'ephemeral' });
});

test('import-cv extraction uses MODEL_EXTRACT with no effort or thinking field', async (t) => {
  let seenParams = null;
  const stub = {
    messages: {
      create: async (params) => {
        seenParams = params;
        return {
          content: [{ type: 'text', text: JSON.stringify({ text: 'x' }) }],
          stop_reason: 'end_turn',
        };
      },
    },
  };
  const { server, base } = await startApp({ betaMode: true, anthropic: stub });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/import-cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Sam Example\nLeeds\nA Levels: Maths (A)' }),
  });
  assert.equal(res.status, 200);
  assert.equal(seenParams.model, 'claude-haiku-4-5');
  assert.equal(seenParams.output_config.effort, undefined);
  assert.equal(seenParams.thinking, undefined);
});

// --- Tests for tailor/diagnose/keyword-gap/interview joining the cost
// refactor (Task 13) -- these 4 routes were brought up to the same standard
// as generate-cv/suggest/polish/import-cv after the scope-narrowing in
// PLAN.md turned out to be based on a stale read; see IMPLEMENTATION.md.

const STOP_REASON_ROUTE_CASES = [
  {
    name: 'tailor',
    appOptions: {},
    request: (base) =>
      fetch(`${base}/api/tailor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job: 'Trainee accountant. Excel required.', facts: 'Skills: Excel' }),
      }),
  },
  {
    name: 'diagnose',
    appOptions: {},
    request: (base) =>
      fetch(`${base}/api/diagnose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Sam Example\nA Levels: Maths (A)' }),
      }),
  },
  {
    name: 'keyword-gap',
    appOptions: {
      jobpilotApiUrl: 'https://api.jobpilot.example',
      corpusFetch: async () => ({
        ok: true,
        json: async () => ({ jobs: [{ title: 'Trainee Accountant', jd_text: 'Excel required' }] }),
      }),
    },
    request: (base) =>
      fetch(`${base}/api/keyword-gap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'Trainee Accountant', facts: 'Skills: Excel' }),
      }),
  },
  {
    name: 'interview',
    appOptions: {},
    request: (base) =>
      fetch(`${base}/api/interview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'Trainee accountant', facts: 'A Levels: Maths', transcript: [] }),
      }),
  },
];

for (const { name, request, appOptions } of STOP_REASON_ROUTE_CASES) {
  test(`stop_reason "refusal" maps to 502 on /api/${name} with no partial model text leaked`, async (t) => {
    const stub = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: `SECRET ${name.toUpperCase()} PARTIAL OUTPUT` }],
          stop_reason: 'refusal',
        }),
      },
    };
    const { server, base } = await startApp({ betaMode: true, anthropic: stub, ...appOptions });
    t.after(() => server.close());

    const res = await request(base);
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.error, 'The AI declined this content — edit your text and try again.');
    assert.doesNotMatch(JSON.stringify(data), new RegExp(`SECRET ${name.toUpperCase()} PARTIAL OUTPUT`));
  });

  test(`stop_reason "max_tokens" maps to 502 on /api/${name}`, async (t) => {
    const stub = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'TRUNCATED HALFWAY THROUGH' }],
          stop_reason: 'max_tokens',
        }),
      },
    };
    const { server, base } = await startApp({ betaMode: true, anthropic: stub, ...appOptions });
    t.after(() => server.close());

    const res = await request(base);
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.error, 'The response was too long — try shorter input.');
  });
}

test('keyword-gap caches the per-role extraction: a second call for the same role skips the corpus fetch and the extract call', async (t) => {
  let corpusCalls = 0;
  const corpusFetch = async () => {
    corpusCalls++;
    return {
      ok: true,
      json: async () => ({ jobs: [{ title: 'Trainee Accountant', jd_text: 'Excel and AAT required' }] }),
    };
  };
  const modelCalls = [];
  const stub = {
    messages: {
      create: async (params) => {
        modelCalls.push(params);
        if (params.model === 'claude-haiku-4-5') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ in_demand: [{ keyword: 'Excel', seen_in: 12 }] }) }],
            stop_reason: 'end_turn',
          };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ matched: [{ keyword: 'Excel', evidence: 'Used Excel for school stall' }], missing: [] }),
          }],
          stop_reason: 'end_turn',
        };
      },
    },
  };
  const { server, base } = await startApp({
    betaMode: true,
    anthropic: stub,
    jobpilotApiUrl: 'https://api.jobpilot.example',
    corpusFetch,
  });
  t.after(() => server.close());

  const post = (role) =>
    fetch(`${base}/api/keyword-gap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, facts: 'Skills: Excel' }),
    });

  const first = await post('Trainee Accountant');
  assert.equal(first.status, 200);
  assert.equal(corpusCalls, 1);
  assert.equal(modelCalls.length, 2, 'cache miss makes the extract call plus the diff call');
  assert.equal(modelCalls[0].model, 'claude-haiku-4-5');
  assert.equal(modelCalls[1].model, 'claude-sonnet-5');

  const second = await post('Trainee Accountant');
  assert.equal(second.status, 200);
  assert.equal(corpusCalls, 1, 'cache hit skips the corpus fetch entirely');
  assert.equal(modelCalls.length, 3, 'cache hit skips extraction; only the diff call runs');
  assert.equal(modelCalls[2].model, 'claude-sonnet-5');

  // Role matching is case/whitespace-insensitive per the roleKey scheme
  const third = await post('  trainee accountant  ');
  assert.equal(third.status, 200);
  assert.equal(corpusCalls, 1, 'still a cache hit despite case/whitespace differences');
  assert.equal(modelCalls.length, 4);
});

test('diagnose paid path is now capped by the monthly AI limit (previously bypassed it entirely)', async (t) => {
  const { server, base } = await startApp({
    betaMode: true,
    betaRateLimit: 100,
    betaMonthlyAiLimit: 2,
    anthropic: jsonStub(DIAGNOSIS),
  });
  t.after(() => server.close());

  const post = () =>
    fetch(`${base}/api/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Sam Example\nA Levels: Maths (A)' }),
    });

  assert.equal((await post()).status, 200, 'call 1 within the monthly cap');
  assert.equal((await post()).status, 200, 'call 2 within the monthly cap');
  const over = await post();
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error, "You've reached this month's AI limit.");
});

test('tailor, diagnose, keyword-gap (both calls) and interview requests include output_config with the expected model/effort/schema shape', async (t) => {
  const seen = [];
  const stub = {
    messages: {
      create: async (params) => {
        seen.push(params);
        if (params.model === 'claude-haiku-4-5') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ in_demand: [{ keyword: 'Excel', seen_in: 5 }] }) }],
            stop_reason: 'end_turn',
          };
        }
        // A response shape broad enough to satisfy whichever of the other
        // three routes made this particular call.
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              summary: 'x', skills: 'Excel', matched: [], missing: [],
              score: 80, flags: [],
              rating: null, feedback: null, done: false, next_question: 'Why this role?',
            }),
          }],
          stop_reason: 'end_turn',
        };
      },
    },
  };
  const corpusFetch = async () => ({
    ok: true,
    json: async () => ({ jobs: [{ title: 'Trainee Accountant', jd_text: 'Excel required' }] }),
  });
  const { server, base } = await startApp({
    betaMode: true,
    anthropic: stub,
    jobpilotApiUrl: 'https://api.jobpilot.example',
    corpusFetch,
  });
  t.after(() => server.close());

  await fetch(`${base}/api/tailor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: 'Trainee accountant. Excel required.', facts: 'Skills: Excel' }),
  });
  await fetch(`${base}/api/diagnose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Sam Example\nA Levels: Maths (A)' }),
  });
  await fetch(`${base}/api/keyword-gap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'Trainee Accountant', facts: 'Skills: Excel' }),
  });
  await fetch(`${base}/api/interview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'Trainee accountant', facts: 'A Levels: Maths', transcript: [] }),
  });

  assert.equal(seen.length, 5, 'tailor + diagnose + keyword-gap (extract+diff) + interview');
  for (const params of seen) {
    assert.equal(params.output_config.format.type, 'json_schema');
    assert.equal(typeof params.output_config.format.schema, 'object');
  }

  const [tailorParams, diagnoseParams, extractParams, diffParams, interviewParams] = seen;
  assert.equal(tailorParams.model, 'claude-sonnet-5');
  assert.equal(tailorParams.output_config.effort, 'medium');
  assert.equal(tailorParams.output_config.format.schema.additionalProperties, false);

  assert.equal(diagnoseParams.model, 'claude-sonnet-5');
  assert.equal(diagnoseParams.output_config.effort, 'medium');
  assert.equal(diagnoseParams.output_config.format.schema.additionalProperties, false);

  assert.equal(extractParams.model, 'claude-haiku-4-5');
  assert.equal(extractParams.output_config.effort, undefined);
  assert.equal(extractParams.thinking, undefined);

  assert.equal(diffParams.model, 'claude-sonnet-5');
  assert.equal(diffParams.output_config.effort, 'low');

  assert.equal(interviewParams.model, 'claude-sonnet-5');
  assert.equal(interviewParams.output_config.effort, 'low');
  assert.ok(Array.isArray(interviewParams.output_config.format.schema.anyOf), 'interview schema is a discriminated union');
});

// --- Peer-review follow-ups (REVIEW-1.md): keyword-gap cache eviction bug,
// missing in-flight dedup for concurrent identical-role misses, and a
// stop_reason test that isolates the diff call's own catch block.

test('cacheRoleCorpus: refreshing an existing key at capacity promotes it without evicting an unrelated entry (regression for REVIEW-1.md finding #1)', () => {
  const { cacheRoleCorpus } = require('../server');
  const cache = new Map();
  cacheRoleCorpus(cache, 3, 'a', { v: 'A' });
  cacheRoleCorpus(cache, 3, 'b', { v: 'B' });
  cacheRoleCorpus(cache, 3, 'c', { v: 'C' });
  assert.equal(cache.size, 3);
  assert.deepEqual([...cache.keys()], ['a', 'b', 'c']);

  // Refresh 'a' -- the oldest key by insertion order, but NOT the key an
  // unrelated-eviction bug would spare -- while the cache is at capacity.
  // Before the fix, a size-only eviction check would delete a key here
  // regardless of whether 'a' already existed, shrinking the cache by one
  // on every refresh.
  cacheRoleCorpus(cache, 3, 'a', { v: 'A2' });
  assert.equal(cache.size, 3, 'refreshing an existing key at capacity must not shrink the cache');
  assert.deepEqual([...cache.keys()], ['b', 'c', 'a'], 'the refreshed key is promoted to newest');
  assert.equal(cache.get('a').v, 'A2', 'the refreshed key carries its new value');
  assert.ok(cache.has('b') && cache.has('c'), 'unrelated entries survive a refresh');
  assert.equal(cache.get('b').v, 'B');
  assert.equal(cache.get('c').v, 'C');

  // A genuinely new key at capacity still evicts the true oldest -- which is
  // now 'b' (the refresh above promoted 'a' out of the oldest slot).
  cacheRoleCorpus(cache, 3, 'd', { v: 'D' });
  assert.equal(cache.size, 3);
  assert.deepEqual([...cache.keys()], ['c', 'a', 'd']);
  assert.ok(!cache.has('b'), 'the true oldest entry is evicted for a genuinely new key at capacity');
});

test('keyword-gap cache evicts the oldest role once genuinely new roles exceed the configured cap', async (t) => {
  let corpusCalls = 0;
  const corpusFetch = async () => {
    corpusCalls++;
    return { ok: true, json: async () => ({ jobs: [{ title: 'Role', jd_text: 'Requirements' }] }) };
  };
  const stub = {
    messages: {
      create: async (params) => {
        if (params.model === 'claude-haiku-4-5') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ in_demand: [{ keyword: 'Excel', seen_in: 5 }] }) }],
            stop_reason: 'end_turn',
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ matched: [], missing: [] }) }], stop_reason: 'end_turn' };
      },
    },
  };
  const { server, base } = await startApp({
    betaMode: true,
    anthropic: stub,
    jobpilotApiUrl: 'https://api.jobpilot.example',
    corpusFetch,
    keywordGapCacheMax: 3,
  });
  t.after(() => server.close());

  const post = (role) =>
    fetch(`${base}/api/keyword-gap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, facts: 'Skills: Excel' }),
    });

  await post('Role A');
  await post('Role B');
  await post('Role C');
  assert.equal(corpusCalls, 3, 'three distinct roles fill the cache to its cap of 3');

  await post('Role A');
  assert.equal(corpusCalls, 3, 'role A is still cached (a Map.get by a cache hit does not evict or reorder)');

  // A genuinely new 4th role at capacity evicts the oldest -- still A, since
  // the cache-hit re-query above doesn't promote it.
  await post('Role D');
  assert.equal(corpusCalls, 4, 'role D is a fresh fetch');

  await post('Role A');
  assert.equal(corpusCalls, 5, 'role A was evicted for room and requires a fresh corpus fetch');
  // Cache is now {C, D, A} -- re-inserting A (at capacity again) evicted B,
  // the oldest at that point (the earlier hit on A never promoted it, and A
  // was freshly re-added after D, so B -- never touched since its original
  // insertion -- was the true oldest).

  await post('Role C');
  assert.equal(corpusCalls, 5, 'role C is still cached');

  await post('Role B');
  assert.equal(corpusCalls, 6, 'role B was evicted (cache only holds 3 of the 4 distinct roles touched) and requires a fresh corpus fetch');
});

test('keyword-gap dedupes concurrent requests for the same uncached role into one corpus fetch and one extraction call', async (t) => {
  let corpusCalls = 0;
  const corpusFetch = async () => {
    corpusCalls++;
    // Delay resolution so both concurrent requests are provably in flight
    // together before either completes -- not just fast enough to interleave
    // by luck.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, json: async () => ({ jobs: [{ title: 'Trainee Accountant', jd_text: 'Excel required' }] }) };
  };
  let extractCalls = 0;
  const stub = {
    messages: {
      create: async (params) => {
        if (params.model === 'claude-haiku-4-5') {
          extractCalls++;
          return {
            content: [{ type: 'text', text: JSON.stringify({ in_demand: [{ keyword: 'Excel', seen_in: 5 }] }) }],
            stop_reason: 'end_turn',
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ matched: [], missing: [] }) }], stop_reason: 'end_turn' };
      },
    },
  };
  const { server, base } = await startApp({
    betaMode: true,
    anthropic: stub,
    jobpilotApiUrl: 'https://api.jobpilot.example',
    corpusFetch,
  });
  t.after(() => server.close());

  const post = () =>
    fetch(`${base}/api/keyword-gap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'Trainee Accountant', facts: 'Skills: Excel' }),
    });

  const [r1, r2] = await Promise.all([post(), post()]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(corpusCalls, 1, 'only one corpus fetch for two concurrent requests on the same uncached role');
  assert.equal(extractCalls, 1, 'only one extraction call for two concurrent requests on the same uncached role');
});

test('stop_reason failure in keyword-gap\'s diff call (not the extraction call) maps to 502 via its own catch block', async (t) => {
  let callCount = 0;
  const stub = {
    messages: {
      create: async (params) => {
        callCount++;
        if (params.model === 'claude-haiku-4-5') {
          // Extraction succeeds -- isolates the diff call's own catch block.
          return {
            content: [{ type: 'text', text: JSON.stringify({ in_demand: [{ keyword: 'Excel', seen_in: 5 }] }) }],
            stop_reason: 'end_turn',
          };
        }
        return { content: [{ type: 'text', text: 'SECRET DIFF PARTIAL OUTPUT' }], stop_reason: 'refusal' };
      },
    },
  };
  const corpusFetch = async () => ({
    ok: true,
    json: async () => ({ jobs: [{ title: 'Trainee Accountant', jd_text: 'Excel required' }] }),
  });
  const { server, base } = await startApp({
    betaMode: true,
    anthropic: stub,
    jobpilotApiUrl: 'https://api.jobpilot.example',
    corpusFetch,
  });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/keyword-gap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'Trainee Accountant', facts: 'Skills: Excel' }),
  });
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.error, 'The AI declined this content — edit your text and try again.');
  assert.doesNotMatch(JSON.stringify(data), /SECRET DIFF PARTIAL OUTPUT/);
  assert.equal(callCount, 2, 'extraction (call 1) succeeded before the diff call (call 2) failed');
});

test('import-cv extracts a BTEC and a predicted GCSE into the qualifications array', async (t) => {
  const extraction = {
    name: 'Sam Example', dob: '', address: 'Leeds', email: 'sam@example.com', phone: '', links: '', profile: '',
    school: 'Leeds City College', schooldates: '2024 – 2026', gcse: '',
    qualifications: [
      { level: 'BTEC', subject: 'Applied Science', grade: 'Distinction', predicted: false },
      { level: 'GCSE', subject: 'Maths', grade: '7', predicted: true },
    ],
    projects: [], quant: '', skills: '', jobs: [], responsibility: '', sport: '',
    fitness: '', awards: '', interests: '',
  };
  const { server, base } = await startApp({ betaMode: true, anthropic: jsonStub(extraction) });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/import-cv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Sam Example\nLeeds City College\nBTEC Applied Science: Distinction\nMaths: 7 (predicted)' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ai, true);
  const obj = JSON.parse(data.result);
  assert.equal(obj.qualifications.length, 2);
  const btec = obj.qualifications.find((q) => q.level === 'BTEC');
  assert.equal(btec.subject, 'Applied Science');
  assert.equal(btec.grade, 'Distinction');
  assert.equal(btec.predicted, false);
  const gcse = obj.qualifications.find((q) => q.level === 'GCSE');
  assert.equal(gcse.subject, 'Maths');
  assert.equal(gcse.grade, '7');
  assert.equal(gcse.predicted, true);
});


test('EXTRACT_PROMPT carries the generic qualifications schema, not alevels', () => {
  const { EXTRACT_PROMPT } = require('../lib/anthropic');
  assert.match(
    EXTRACT_PROMPT,
    /"qualifications":\[\{"level":"","subject":"","grade":"","predicted":false\}\]/,
  );
  assert.doesNotMatch(EXTRACT_PROMPT, /"alevels"/);
  assert.match(EXTRACT_PROMPT, /NEVER guess or invent/);
  assert.match(EXTRACT_PROMPT, /predicted.*true only when the CV text itself says/);
});

test('migrateQualifications() passes a well-formed new-shape array through unchanged', () => {
  const { migrateQualifications } = loadFrontendHelpers();
  const result = migrateQualifications({
    qualifications: [
      { level: 'BTEC', subject: 'Applied Science', grade: 'Distinction', predicted: false },
      { level: 'GCSE', subject: 'Maths', grade: '7', predicted: true },
    ],
  });
  assert.deepEqual(result, [
    { level: 'BTEC', subject: 'Applied Science', grade: 'Distinction', predicted: false },
    { level: 'GCSE', subject: 'Maths', grade: '7', predicted: true },
  ]);
});

test('migrateQualifications() maps old alevels {subj,grade} rows to level:"A-level"', () => {
  const { migrateQualifications } = loadFrontendHelpers();
  const result = migrateQualifications({ alevels: [{ subj: 'Maths', grade: 'A*' }, { subj: 'Physics', grade: 'A' }] });
  assert.deepEqual(result, [
    { level: 'A-level', subject: 'Maths', grade: 'A*', predicted: false },
    { level: 'A-level', subject: 'Physics', grade: 'A', predicted: false },
  ]);
});

test('migrateQualifications() prefers a non-empty qualifications array over a stale alevels key', () => {
  const { migrateQualifications } = loadFrontendHelpers();
  const result = migrateQualifications({
    qualifications: [{ level: 'GCSE', subject: 'Maths', grade: '9', predicted: false }],
    alevels: [{ subj: 'Physics', grade: 'A' }], // stale — must be ignored
  });
  assert.deepEqual(result, [{ level: 'GCSE', subject: 'Maths', grade: '9', predicted: false }]);
});

test('migrateQualifications() normalizes an off-enum level to "Other" instead of dropping or passing it through', () => {
  // Regression test for review finding #1: EXTRACT_PROMPT has no formal
  // enum validation, so the model (or a hand-pasted import) can emit a
  // level string that doesn't exactly match one of the 9 canonical values
  // (e.g. an international qualification like "IB Diploma"). Before the
  // fix this row silently vanished from the Education block and AI facts
  // (whitelist-based) while still leaking into the profile summary
  // (blacklist-based) — normalizing to "Other" here keeps every consumer
  // consistent.
  const { migrateQualifications } = loadFrontendHelpers();
  const result = migrateQualifications({
    qualifications: [{ level: 'IB Diploma', subject: 'International Baccalaureate', grade: '38 points', predicted: false }],
  });
  assert.deepEqual(result, [{ level: 'Other', subject: 'International Baccalaureate', grade: '38 points', predicted: false }]);

  // Case-insensitive matching still maps onto the canonical spelling.
  const caseInsensitive = migrateQualifications({ qualifications: [{ level: 'gcse', subject: 'Maths', grade: '9', predicted: false }] });
  assert.equal(caseInsensitive[0].level, 'GCSE');

  // A missing level still defaults to "A-level" (unchanged existing behaviour).
  const missingLevel = migrateQualifications({ qualifications: [{ subject: 'Maths', grade: 'A*', predicted: false }] });
  assert.equal(missingLevel[0].level, 'A-level');
});

test('migrateQualifications() returns [] for a source with neither key, and rows missing subject/subj are dropped', () => {
  const { migrateQualifications } = loadFrontendHelpers();
  assert.deepEqual(migrateQualifications({}), []);
  assert.deepEqual(migrateQualifications(null), []);
  assert.deepEqual(migrateQualifications({ qualifications: [{ level: 'GCSE', grade: '9' }] }), []); // no subject
  assert.deepEqual(migrateQualifications({ alevels: [{ grade: 'A*' }] }), []); // no subj
});

test('gradeText()/qualRowText() append "(predicted)" after the grade consistently', () => {
  const { gradeText, qualRowText } = loadFrontendHelpers();
  assert.equal(gradeText({ grade: 'A*', predicted: false }), 'A*');
  assert.equal(gradeText({ grade: 'A*', predicted: true }), 'A* (predicted)');
  assert.equal(gradeText({ grade: '', predicted: true }), '(predicted)');
  assert.equal(gradeText({ grade: '', predicted: false }), '');
  assert.equal(qualRowText({ subject: 'Maths', grade: 'A*', predicted: true }), 'Maths A* (predicted)');
  assert.equal(qualRowText({ subject: 'Maths', grade: '', predicted: false }), 'Maths');
});

test('profileQualificationsBase() mentions BOTH an A-level and a BTEC when the student has both (round 1 should-fix #2 regression)', () => {
  // Before the fix, HIGHER_TIER_LEVELS excluded BTEC/T-Level, so a student
  // with both an A-level and a BTEC got a profile sentence mentioning only
  // the A-level even though the Education block correctly listed both.
  const helpers = loadFrontendHelpers();
  helpers.setField('f_gcse', '');
  helpers.state.qualifications = [
    { level: 'A-level', subject: 'Maths', grade: 'A', predicted: false },
    { level: 'BTEC', subject: 'Applied Science', grade: 'Distinction', predicted: false },
  ];
  const base = helpers.profileQualificationsBase();
  assert.match(base, /Maths A/);
  assert.match(base, /Applied Science Distinction/);
});

test('qualificationsFactsLine() does not duplicate GCSE info when f_gcse and an individual GCSE row are both present (round 1 should-fix #3 regression)', () => {
  const helpers = loadFrontendHelpers();
  helpers.setField('f_gcse', '9 GCSEs incl. Maths 8, English 7');
  helpers.state.qualifications = [
    { level: 'GCSE', subject: 'Maths', grade: '6', predicted: false }, // stale/conflicting row — summary must win
  ];
  const line = helpers.qualificationsFactsLine();
  // The free-text summary wins — appears exactly once — and the
  // individually entered (and disagreeing) row grade never leaks in.
  const gcseMentions = (line.match(/GCSEs:/g) || []).length;
  assert.equal(gcseMentions, 1);
  assert.match(line, /9 GCSEs incl\. Maths 8, English 7/);
  assert.doesNotMatch(line, /Maths 6/);
});

test('qualificationsFactsLine() still reports GCSEs when only f_gcse is filled in, with no other qualifications rows (round 2 regression: suggestAI() GCSE info loss)', () => {
  // Round 2 finding: the should-fix #3 fix made qualificationsFactsLine()
  // skip GCSE rows whenever f_gcse was filled in, on the assumption that
  // callers separately send their own "GCSEs: <summary>" line — true for
  // buildPrompt()/tailorFacts() but NOT suggestAI(), which builds its
  // context purely from stageFactsLine() + qualificationsFactsLine() and
  // never reads f_gcse itself. A GCSE-stage student who only fills in the
  // f_gcse summary (its own placeholder text makes it the obviously
  // intended primary way to record GCSEs) would have every one of their
  // qualifications silently reported as "none listed" to /api/suggest.
  const helpers = loadFrontendHelpers();
  helpers.setField('f_gcse', '10 GCSEs grades 9-7');
  helpers.state.qualifications = [];
  const line = helpers.qualificationsFactsLine();
  assert.notEqual(line, 'none listed');
  assert.match(line, /GCSEs: 10 GCSEs grades 9-7/);
});

test('qualificationsFactsLine() falls back to individual GCSE rows when f_gcse is empty, and to "none listed" when nothing is entered', () => {
  const helpers = loadFrontendHelpers();
  helpers.setField('f_gcse', '');
  helpers.state.qualifications = [{ level: 'GCSE', subject: 'Maths', grade: '9', predicted: true }];
  assert.match(helpers.qualificationsFactsLine(), /GCSEs: Maths 9 \(predicted\)/);

  helpers.state.qualifications = [];
  assert.equal(helpers.qualificationsFactsLine(), 'none listed');
});

test('stageFactsLine()/defaultQualLevelForStage() read f_stage and default sensibly', () => {
  const helpers = loadFrontendHelpers();
  helpers.setField('f_stage', 'gcse');
  assert.equal(helpers.stageFactsLine(), 'STAGE: Finishing GCSEs / Year 11');
  assert.equal(helpers.defaultQualLevelForStage(), 'GCSE');

  helpers.setField('f_stage', 'scottish');
  assert.equal(helpers.defaultQualLevelForStage(), 'National 5');

  // Unrecognized/blank stage value falls back to the A-levels default,
  // matching the <select>'s own HTML "selected" default.
  helpers.setField('f_stage', '');
  assert.equal(helpers.stageFactsLine(), 'STAGE: A-levels or college (Year 12–13)');
  assert.equal(helpers.defaultQualLevelForStage(), 'A-level');
});
