<!-- Facet: privacy-first, Cloudflare-native analytics + experimentation. Project landing README. -->

<!-- Header: title + subtitle at left, logo floated right (theme-aware via GitHub's #gh-*-mode-only). -->
<img align="right" width="150" height="150" hspace="40" alt="Facet logo" src="./assets/logo-black.png#gh-light-mode-only">
<img align="right" width="150" height="150" hspace="40" alt="Facet logo" src="./assets/logo-white.png#gh-dark-mode-only">

# Facet

### Privacy-first, cookieless web analytics &amp; experimentation

Runs entirely on the Cloudflare edge — no cookies, no external database,<br>
and no cross-session identity to leak.

<br clear="right">

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/writerslogic/facet"><img alt="Deploy to Cloudflare" src="https://img.shields.io/badge/Deploy%20to-Cloudflare-f38020.svg?logo=cloudflare&logoColor=white"></a>
  <a href="https://github.com/writerslogic/facet/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/writerslogic/facet/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.7-blue.svg"></a>
  <a href="https://workers.cloudflare.com"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-f38020.svg"></a>
  <a href="https://github.com/writerslogic/facet/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg"></a>
  <a href="https://orcid.org/0009-0003-1849-2963"><img alt="ORCID" src="https://img.shields.io/badge/ORCID-0009--0003--1849--2963-green.svg"></a>
</p>

Facet is a self-hosted analytics platform that runs 100% on Cloudflare Workers + D1 — no external
database, no long-running server, one `wrangler deploy`. It measures your site by *facet*: pages,
referrers, countries, devices, channels, sessions, goals, funnels, and experiments. It is
**cookieless and GDPR-friendly by construction**: unique visitors are counted with a
daily-rotating, salted `SHA-256` hash, **raw IP addresses are never stored**, and there is no
cross-session identity to leak. The browser client is a drop-in for umami — existing sites migrate
by swapping a single script tag.

## Why Facet

- **Single deploy.** One Worker serves ingest, the stats API, the dashboard, and cron rollups.
- **No database to run.** State lives in Cloudflare D1; sessions and rollups are materialized by an hourly cron.
- **Cookieless & GDPR-friendly.** Privacy-safe uniques via `SHA-256(ip + user_agent + daily_salt + site_id)`; no cookies, no cross-session identity, no raw IP stored.
- **umami-compatible client.** `window.umami.track(name, props)`, auto-pageviews, SPA navigation, UTM capture, and form-submission tracking work out of the box.
- **Sessions & engagement.** Bounce rate, pages/session, and average visit duration.
- **Traffic channels.** Automatic direct / referral / organic / social / paid / email classification from referrer + UTM.
- **Goals, conversions & funnels.** Define goals and multi-step funnels; get conversion rates and in-order funnel drop-off.
- **A/B experiments & feature flags.** Privacy-first, client-side variant assignment; two-proportion significance testing in the dashboard.
- **Anomaly detection & autopsy.** Automatic z-score detection with a plain-language root-cause summary (largest-contributing segment).
- **Ask in plain English.** Natural-language queries over your stats via Workers AI, translated to a constrained, safe query intent.
- **Realtime.** Active-visitor snapshot over a 5-minute window (distinct daily hashes; no cookies or persistent id).
- **Ad-block-resilient.** First-party `POST /api/event` server-to-server ingest — no client script to block.
- **Visitor opt-out & Do-Not-Track.** Honors browser DNT and a per-visitor opt-out; ignored visitors are never recorded.
- **CSV / JSON export.** Export any series or breakdown from the API or dashboard; CSV is spreadsheet formula-injection-safe.
- **In-dashboard admin.** A Settings tab manages sites and API keys, with one-click multi-site switching.
- **Verifiable trust & provenance.** Optional signed statements about the deployment — published keys (`did:web` + JWKS), a W3C VC 2.0 privacy attestation, a RATS build/config evidence EAT, and a SCITT transparency log — with hardware-rootable signing keys. See [`docs/trust.md`](./docs/trust.md).
- **Free, self-issued API keys** and **unlimited, first-class multi-site.**

## How privacy works

A visitor is identified for **one UTC day only** by `SHA-256(ip ⧊ user_agent ⧊ daily_salt ⧊ site_id)`,
rendered as lowercase hex. The salt rotates at UTC midnight, so the same person produces a different
hash the next day and cross-day re-identification is cryptographically prevented. The raw IP is used
only to compute that hash in memory and is never stored, logged, or returned. See
[`docs/privacy.md`](./docs/privacy.md) for the full model.

## Packages

| Path | Published as | Purpose |
| --- | --- | --- |
| `apps/server` | — | Cloudflare Worker: ingest + stats API + admin + cron rollups + D1 schema |
| `apps/dashboard` | — | React 19 + Vite dashboard, served as static assets by the Worker |
| `packages/client` | [`@writerslogic/facet`](https://www.npmjs.com/package/@writerslogic/facet) | Browser tracking snippet (zero deps, umami shim) |
| `packages/cli` | [`@writerslogic/facet-cli`](https://www.npmjs.com/package/@writerslogic/facet-cli) (`npx @writerslogic/facet-cli`) | Setup, admin, reporting, offline verification, key generation & selective disclosure CLI |
| `packages/shared` | — | Shared TypeScript types + valibot wire schemas |
| `packages/trust` | — | Workers-native trust & provenance primitives (keys/JWKS, JWS/COSE, VC, DID, MMR, SCITT, RATS) |

## Quick start

**Add tracking to a site** — drop in the standalone script (umami-compatible):

```html
<script defer src="https://your-deployment.example.com/script.js" data-site-id="YOUR_SITE_ID"></script>
```

**Or use it programmatically:**

```sh
npm install @writerslogic/facet
```

```ts
import { init, track, variant } from '@writerslogic/facet';

init({ host: 'https://your-deployment.example.com', siteId: 'YOUR_SITE_ID' });
track('signup', { plan: 'pro' });
const cta = variant('homepage_cta'); // privacy-first A/B assignment
```

**Create a site & API key** (admin, against your deployment):

```sh
curl -X POST https://your-deployment.example.com/api/sites \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"name":"My Site","domain":"example.com"}'

curl -X POST https://your-deployment.example.com/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"site_id":"<the site id from above>"}'
```

**Build & test locally:**

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

## Dashboard

The dashboard is a React SPA served by the Worker at the root path. Enter an API key + site id to
view Overview (KPIs, traffic chart, top-lists, channels, realtime), Funnels & conversions,
Experiments, and Anomalies, plus an "Ask" tab for natural-language queries. Custom date ranges with
period-over-period comparison and CSV/JSON export are available throughout. A **Settings** tab
(admin token) manages sites and API keys, with one-click multi-site switching.

## Documentation

- [Usage](./docs/usage.md) — the tracking snippet, npm API, UTM & form tracking, umami migration
- [Self-hosting](./docs/self-hosting.md) — one-command deploy on Cloudflare Workers + D1
- [Privacy model](./docs/privacy.md) — the hashing design, salt rotation, and retention
- [Trust & provenance](./docs/trust.md) — signed deployment attestations, verification, hardware-rooted keys
- [API reference](./docs/api.md) — every endpoint, auth, and error code
- [CHANGELOG](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

## License

[Apache-2.0](./LICENSE) © 2026 WritersLogic, Inc.
