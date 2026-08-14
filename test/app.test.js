'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp } = require('../server');

const CHECKOUT_URL = 'https://teststore.lemonsqueezy.com/buy/abc-123';

function stubAnthropic() {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: 'GENERATED CV TEXT' }] }),
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
