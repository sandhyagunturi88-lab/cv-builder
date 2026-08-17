# CV Builder

UK school-leaver CV builder with live preview, PDF/Word export, and AI generation (Claude), monetised as a subscription via Lemon Squeezy (merchant of record). **Paid-only AI by default**: building/preview/export are free, every AI feature needs an active licence key. An opt-in **beta mode** (`BETA_MODE=true`) makes AI free for local testing and promos.

## Running as the JobPilot plugin

This app lives in the JobPilot UK monorepo as `apps/cv-builder` and doubles as
JobPilot's **CV Studio** plugin:

- `npm run dev:cv-builder` (from the repo root) starts it on port 3000; the
  PWA links to it via `VITE_CVBUILDER_URL` and onboarding uses its
  `POST /api/extract-text` endpoint for PDF/Word CV import (deterministic
  pdf-parse/mammoth extraction — no model call, nothing stored, CORS open).
- The `POST /api/extract-text` endpoint is deterministic (no model call) and
  stays open regardless of mode. AI routes require a licence key by default;
  set `BETA_MODE=true` only if JobPilot's own billing (Stripe) is fronting
  access instead of Lemon Squeezy.
- Every AI route uses a per-route model tier (`MODEL_GENERATE`, `MODEL_LIGHT`,
  `MODEL_EXTRACT` — see `.env.example`) so the cheap, mechanical routes don't
  pay Opus prices: `generate-cv` on `MODEL_GENERATE`; `suggest`, `polish`,
  `tailor`, `diagnose`, and keyword-gap's per-user diff call on `MODEL_LIGHT`;
  `import-cv`'s AI extraction and keyword-gap's in-demand-skills extraction on
  `MODEL_EXTRACT`; mock interviews on their own `INTERVIEW_MODEL`. The old
  single `ANTHROPIC_MODEL` convention is no longer used by any route.

## Setup (under 10 lines)

```bash
git clone <this repo> && cd cv-builder
npm install
copy .env.example .env        # (cp on macOS/Linux)
# edit .env — set ANTHROPIC_API_KEY (AI is paid-only unless you set BETA_MODE=true)
npm start
# open http://localhost:3000
npm test                      # run the test suite
```

## The four career skills (new)

- **CV health check** — `POST /api/diagnose` scores the CV the way an ATS parses it (0–100 + flagged sections with fixes). **Two-tier like import**: without a licence it's a free **deterministic** teaser (regex/heuristics — **zero model calls, zero cost**) showing the score + the single worst flag, 3 checks per IP per day — the ad-landing hook ("see your score free, pay to fix it"). A licence gets the full Claude report, drawing from the normal hourly bucket. The free tier never calls the model.
- **XYZ rewriting** — the generate and polish prompts now shape bullets as *accomplishment X, as measured by Y, by doing Z* (Google's XYZ formula). Missing measures become `[placeholders]`, never invented numbers.
- **Role keyword gap** — `POST /api/keyword-gap` pulls up to 40 real ingested UK adverts for the target role from the JobPilot API (`GET /api/v1/jobs/role-corpus`), then diffs the CV facts against what they actually ask for: in-demand keywords, honest matches with evidence, honest gaps with a way to close each. Split into two model calls for cost: the in-demand-skills extraction from the (large) advert corpus runs once per role and is cached server-side for 24h, so repeat requests for a role skip the corpus fetch and extraction entirely; only the cheap per-user diff call runs every time. **Feature-flagged**: hidden unless `JOBPILOT_API_URL` is set (`GET /api/features` tells the front end). Ship with it off; flip the env var when the API is production-ready.
- **Mock interview** — `POST /api/interview` runs a stateless multi-turn interview: Claude plays the hiring manager for the target role, one question at a time, rates each answer /10 with feedback, then a final summary. Runs on `INTERVIEW_MODEL` (default `claude-sonnet-5` — a session is ~8 calls) with its **own rate buckets**: 60 turns/hour paid (20 beta) plus a hard cap of 5 new sessions per key/IP per day, so interviews never drain the generation bucket.

## How access control works

- **`BETA_MODE=false`** (default): AI requests must carry an `X-License-Key` header. The key is validated against the Lemon Squeezy License API and cached in memory for 10 minutes. Invalid/missing keys get a `402` with the checkout URL so the UI can show the Subscribe panel (£4.99/month). Rate limit: 30 generations/hour per license key.
- **`BETA_MODE=true`** (opt-in, for local testing/promos): every AI generation is allowed; responses include `beta: true` and the UI shows a "Free during beta" badge. Rate limit: 10 generations/hour per IP.
- CV content is never stored server-side — logs contain timestamps and statuses only (GDPR data minimisation).

## Creating the Lemon Squeezy product

1. Create a store on [lemonsqueezy.com](https://www.lemonsqueezy.com) and add a **product** with a **subscription** price of **£4.99/month** — this is the price advertised on the landing page's pricing section and the in-app upgrade panel, so keep them in sync if it changes.
2. In the product's variant settings, enable **License keys**. Because the key belongs to the subscription, cancelling the subscription automatically expires the key — that's the whole auth system; no user database needed for v1.
3. Copy the product's **checkout URL** (Share → checkout link) into `LEMONSQUEEZY_CHECKOUT_URL`.
4. Create an API key (Settings → API) into `LEMONSQUEEZY_API_KEY`.
5. Add a **webhook** (Settings → Webhooks) pointing at `https://your-domain/api/ls-webhook`, subscribed to `subscription_cancelled`, `subscription_expired`, and the `license_key_*` events. Put the signing secret in `LEMONSQUEEZY_WEBHOOK_SECRET`. The webhook evicts cancelled keys from the validation cache immediately (they'd fall out within 10 minutes anyway).

## Going live with payments

Paid-only is already the default — just set the three `LEMONSQUEEZY_*` vars in your host's environment and restart. Without a valid key the UI shows the Subscribe panel; the checkout link comes from `LEMONSQUEEZY_CHECKOUT_URL`.

## Deploying (Render / Railway / Fly)

This is a plain Node + Express app with no database:

- **Render / Railway**: create a Web Service from the repo; build command `npm install`, start command `npm start`. Set the env vars from `.env.example` in the dashboard. Both platforms inject `PORT` automatically.
- **Fly.io**: `fly launch` (Node is auto-detected), then `fly secrets set ANTHROPIC_API_KEY=... LEMONSQUEEZY_API_KEY=... ...` and `fly deploy`.
- Caches and rate limits are in-memory, so run a **single instance** for v1. Remember to point the Lemon Squeezy webhook at the deployed URL.

## Swapping the payment provider

All Lemon Squeezy specifics (license validation API, webhook signature scheme, webhook event shapes) live behind a small provider interface in `lib/providers/lemonsqueezy.js`:

```js
{ name, validateKey(key), verifyWebhook(rawBody, getHeader), parseWebhook(payload) }
```

To move to Dodo Payments or Paddle: implement that interface in a new file under `lib/providers/`, and change the one `createLemonSqueezyProvider(...)` line in `server.js` to use it. `lib/licensing.js` (beta flag, 10-minute key cache, webhook dispatch) and the routes are provider-agnostic. The webhook endpoint is `/api/payments-webhook` (`/api/ls-webhook` is kept as an alias for existing Lemon Squeezy registrations).

## Project layout

```
server.js                        Express app: /api/generate-cv, /api/diagnose, /api/keyword-gap,
                                 /api/interview, /api/features, /api/payments-webhook, /privacy, static
lib/anthropic.js                 Claude Messages API calls + prompts. Per-route model/effort tiers:
                                 MODEL_GENERATE (claude-opus-5) for generate-cv; MODEL_LIGHT
                                 (claude-sonnet-5) for suggest/polish/tailor/diagnose and keyword-gap's
                                 per-user diff call; MODEL_EXTRACT (claude-haiku-4-5) for import-cv's AI
                                 extraction and keyword-gap's in-demand-skills extraction; interviews on
                                 INTERVIEW_MODEL, default claude-sonnet-5; strict no-fabrication rules
lib/licensing.js                 Provider-agnostic access control: beta flag, key cache, webhook dispatch
lib/providers/lemonsqueezy.js    Lemon Squeezy provider (validate API + HMAC webhook + event mapping)
public/cv-builder.html           The app (form, live preview, exports, AI panel) — also works standalone
public/privacy.html              Privacy statement
test/app.test.js                 Node test-runner suite (Anthropic + payment provider stubbed)
```
