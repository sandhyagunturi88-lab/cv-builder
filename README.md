# CV Builder

UK school-leaver CV builder with live preview, PDF/Word export, and AI generation (Claude), monetised as a subscription via Lemon Squeezy (merchant of record). Ships with a **beta mode** where everything is free — no keys, no payments.

## Setup (under 10 lines)

```bash
git clone <this repo> && cd cv-builder
npm install
copy .env.example .env        # (cp on macOS/Linux)
# edit .env — set ANTHROPIC_API_KEY (BETA_MODE=true is the default)
npm start
# open http://localhost:3000
npm test                      # run the test suite
```

## How access control works

- **`BETA_MODE=true`** (default): every AI generation is allowed; responses include `beta: true` and the UI shows a "Free during beta" badge. Rate limit: 10 generations/hour per IP.
- **`BETA_MODE=false`**: requests must carry an `X-License-Key` header. The key is validated against the Lemon Squeezy License API and cached in memory for 10 minutes. Invalid/missing keys get a `402` with the checkout URL so the UI can show a Subscribe panel. Rate limit: 30 generations/hour per license key.
- CV content is never stored server-side — logs contain timestamps and statuses only (GDPR data minimisation).

## Creating the Lemon Squeezy product

1. Create a store on [lemonsqueezy.com](https://www.lemonsqueezy.com) and add a **product** with a **subscription** price (e.g. monthly).
2. In the product's variant settings, enable **License keys**. Because the key belongs to the subscription, cancelling the subscription automatically expires the key — that's the whole auth system; no user database needed for v1.
3. Copy the product's **checkout URL** (Share → checkout link) into `LEMONSQUEEZY_CHECKOUT_URL`.
4. Create an API key (Settings → API) into `LEMONSQUEEZY_API_KEY`.
5. Add a **webhook** (Settings → Webhooks) pointing at `https://your-domain/api/ls-webhook`, subscribed to `subscription_cancelled`, `subscription_expired`, and the `license_key_*` events. Put the signing secret in `LEMONSQUEEZY_WEBHOOK_SECRET`. The webhook evicts cancelled keys from the validation cache immediately (they'd fall out within 10 minutes anyway).

## Flipping to paid at launch

1. Set `BETA_MODE=false` in your host's environment (plus the three `LEMONSQUEEZY_*` vars).
2. Restart the server. That's it — the UI starts showing the Subscribe panel to anyone without a valid key.

## Deploying (Render / Railway / Fly)

This is a plain Node + Express app with no database:

- **Render / Railway**: create a Web Service from the repo; build command `npm install`, start command `npm start`. Set the env vars from `.env.example` in the dashboard. Both platforms inject `PORT` automatically.
- **Fly.io**: `fly launch` (Node is auto-detected), then `fly secrets set ANTHROPIC_API_KEY=... BETA_MODE=true ...` and `fly deploy`.
- Caches and rate limits are in-memory, so run a **single instance** for v1. Remember to point the Lemon Squeezy webhook at the deployed URL.

## Swapping the payment provider

All Lemon Squeezy specifics (license validation API, webhook signature scheme, webhook event shapes) live behind a small provider interface in `lib/providers/lemonsqueezy.js`:

```js
{ name, validateKey(key), verifyWebhook(rawBody, getHeader), parseWebhook(payload) }
```

To move to Dodo Payments or Paddle: implement that interface in a new file under `lib/providers/`, and change the one `createLemonSqueezyProvider(...)` line in `server.js` to use it. `lib/licensing.js` (beta flag, 10-minute key cache, webhook dispatch) and the routes are provider-agnostic. The webhook endpoint is `/api/payments-webhook` (`/api/ls-webhook` is kept as an alias for existing Lemon Squeezy registrations).

## Project layout

```
server.js                        Express app: /api/generate-cv, /api/payments-webhook, /privacy, static
lib/anthropic.js                 Claude Messages API call (claude-sonnet-4-5, markdown no-fabrication prompt)
lib/licensing.js                 Provider-agnostic access control: beta flag, key cache, webhook dispatch
lib/providers/lemonsqueezy.js    Lemon Squeezy provider (validate API + HMAC webhook + event mapping)
public/cv-builder.html           The app (form, live preview, exports, AI panel) — also works standalone
public/privacy.html              Privacy statement
test/app.test.js                 Node test-runner suite (Anthropic + payment provider stubbed)
```
