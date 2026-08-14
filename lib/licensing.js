'use strict';

const CACHE_TTL_MS = 10 * 60 * 1000; // valid keys are re-checked every 10 minutes

/**
 * Provider-agnostic access control. All payment-provider specifics (key
 * validation API, webhook signature scheme, webhook event shapes) live behind
 * the provider interface — see lib/providers/lemonsqueezy.js. Swapping Lemon
 * Squeezy for Dodo Payments or Paddle means implementing that interface in one
 * new provider file; nothing here or in server.js changes.
 *
 * Provider interface:
 *   name                              string
 *   validateKey(key)                  -> Promise<boolean>
 *   verifyWebhook(rawBody, getHeader) -> boolean
 *   parseWebhook(payload)             -> { action: 'revoke_key', key }
 *                                      | { action: 'revoke_all' }
 *                                      | { action: 'ignore' }
 */
function createLicensing({ betaMode = false, checkoutUrl = '', provider } = {}) {
  if (!betaMode && !provider) throw new Error('createLicensing requires a provider unless betaMode is on');
  const cache = new Map(); // license key -> expiry epoch ms

  /**
   * @returns {Promise<{allowed: boolean, beta?: boolean, licenseKey?: string, error?: string}>}
   */
  async function checkAccess(req) {
    if (betaMode) return { allowed: true, beta: true };

    const key = req.get('X-License-Key');
    if (!key) {
      return { allowed: false, error: 'A licence key is required. Subscribe to get one, then paste it in.' };
    }

    const expiry = cache.get(key);
    if (expiry && expiry > Date.now()) {
      return { allowed: true, beta: false, licenseKey: key };
    }
    cache.delete(key);

    const valid = await provider.validateKey(key);
    if (!valid) {
      return { allowed: false, error: 'This licence key is invalid or has expired.' };
    }
    cache.set(key, Date.now() + CACHE_TTL_MS);
    return { allowed: true, beta: false, licenseKey: key };
  }

  /**
   * Verify + process a provider webhook. Transport-agnostic: takes the raw
   * body Buffer and a header getter, returns {status, body} for the route.
   */
  function handleWebhook(rawBody, getHeader) {
    if (!provider || !provider.verifyWebhook(rawBody, getHeader)) {
      return { status: 401, body: { error: 'Invalid webhook signature' } };
    }
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'Invalid JSON payload' } };
    }
    const event = provider.parseWebhook(payload) || { action: 'ignore' };
    if (event.action === 'revoke_key' && event.key) cache.delete(event.key);
    else if (event.action === 'revoke_all') cache.clear();
    return { status: 200, body: { received: true } };
  }

  return {
    checkAccess,
    handleWebhook,
    checkoutUrl,
    evictKey: (key) => cache.delete(key),
    clearCache: () => cache.clear(),
    _cache: cache,
  };
}

module.exports = { createLicensing, CACHE_TTL_MS };
