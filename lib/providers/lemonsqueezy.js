'use strict';

const crypto = require('node:crypto');

const VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';

/**
 * Lemon Squeezy implementation of the payment-provider interface used by
 * lib/licensing.js:
 *
 *   name          string
 *   validateKey(key)                 -> Promise<boolean>  is this key active?
 *   verifyWebhook(rawBody, getHeader) -> boolean          signature valid?
 *   parseWebhook(payload)            -> { action: 'revoke_key', key }
 *                                     | { action: 'revoke_all' }
 *                                     | { action: 'ignore' }
 *
 * To swap in Dodo Payments or Paddle, implement this same interface in a new
 * file under lib/providers/ and pass it to createApp / createLicensing.
 */
function createLemonSqueezyProvider({ apiKey = '', webhookSecret = '', fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  return {
    name: 'lemonsqueezy',

    async validateKey(key) {
      let resp;
      try {
        resp = await doFetch(VALIDATE_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ license_key: key }),
        });
      } catch {
        return false; // network failure — treat as not validated
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.valid !== true) return false;
      // A cancelled subscription flips the key's status away from "active".
      const status = data.license_key && data.license_key.status;
      return !status || status === 'active';
    },

    // Lemon Squeezy signs the raw body with HMAC-SHA256 (hex) in X-Signature.
    verifyWebhook(rawBody, getHeader) {
      const signature = getHeader('X-Signature') || '';
      if (!webhookSecret || !signature) return false;
      const digest = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
      const a = Buffer.from(digest, 'utf8');
      const b = Buffer.from(signature, 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    parseWebhook(payload) {
      const event = (payload.meta && payload.meta.event_name) || '';
      const relevant =
        event === 'subscription_cancelled' ||
        event === 'subscription_expired' ||
        event.startsWith('license_key_');
      if (!relevant) return { action: 'ignore' };
      const key = payload.data && payload.data.attributes && payload.data.attributes.key;
      // Subscription events don't carry the key, so revoke the whole cache —
      // it repopulates within one request per active key.
      return key ? { action: 'revoke_key', key } : { action: 'revoke_all' };
    },
  };
}

module.exports = { createLemonSqueezyProvider, VALIDATE_URL };
