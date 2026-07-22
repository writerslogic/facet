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
  <a href="https://scorecard.dev/viewer/?uri=github.com/writerslogic/facet"><img alt="OpenSSF Scorecard" src="https://api.securityscorecards.dev/projects/github.com/writerslogic/facet/badge"></a>
  <a href="https://slsa.dev"><img alt="SLSA Build Level 2" src="https://img.shields.io/badge/SLSA-Build%20L2-2ea44f.svg?logo=slsa&logoColor=white"></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.7-blue.svg"></a>
  <a href="https://workers.cloudflare.com"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-f38020.svg"></a>
  <a href="https://github.com/writerslogic/facet/blob/main/LICENSING.md"><img alt="License: AGPL-3.0 + commercial" src="https://img.shields.io/badge/License-AGPL--3.0%20%2B%20commercial-blue.svg"></a>
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

## Architecture at a glance

One Cloudflare Worker is the whole backend — ingest, the stats API, the dashboard assets, and the
scheduled rollups all run in it. State lives in D1; there is no server to operate.

```
  browser beacon ─┐                          ┌─ GET /api/stats/*  ──► Dashboard (SPA, served by Worker)
  POST /api/collect├─► Worker ─► privacy hash │
  server events   ─┘   (ingest)   + validate  └─ GET /.well-known/* + /api/attestation/* (signed provenance)
  POST /api/event                    │
                                     ▼
                            D1 (raw events, salts)
                                     │
                     hourly cron ────┤ sessionize · roll up · detect anomalies · purge past retention
                                     ▼
                         D1 (sessions, event_rollups)  ──► fast, aggregate-only reads
```

Ingest hashes and validates in-memory (raw IP never stored), writes raw events to D1, and an hourly
cron folds them into sessions and durable rollups; the stats API and dashboard read only aggregates.

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

## Supply chain & provenance

Every published release carries **two independent, Sigstore-signed provenance attestations** (recorded
in the public Rekor transparency log), so you can verify that an `@writerslogic/*` package was built
from this repo by its GitHub Actions workflow — currently **[SLSA](https://slsa.dev) Build Level 2**:

```sh
# npm provenance (source commit + build workflow)
npm audit signatures

# GitHub build-provenance attestation over the exact tarball
gh attestation verify "$(npm pack @writerslogic/facet-cli --silent)" --repo writerslogic/facet
```

Beyond the packages, a *deployment* signs machine-readable statements about itself (keys, privacy
processing, build/config evidence) — see [Trust & provenance](./docs/trust.md). Security policy and
reporting: [SECURITY.md](./SECURITY.md).

## Documentation

- [Usage](./docs/usage.md) — the tracking snippet, npm API, UTM & form tracking, umami migration
- [Self-hosting](./docs/self-hosting.md) — one-command deploy on Cloudflare Workers + D1
- [Privacy model](./docs/privacy.md) — the hashing design, salt rotation, and retention
- [Trust & provenance](./docs/trust.md) — signed deployment attestations, verification, hardware-rooted keys
- [Standards & conformance](./docs/standards.md) — the open standards Facet implements, and where
- [API reference](./docs/api.md) — every endpoint, auth, and error code
- [CHANGELOG](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

## License

Open source with a commercial option, © 2026 WritersLogic, Inc. The server and dashboard are
**[AGPL-3.0](./LICENSE)** (self-host free; offering a modified hosted service requires sharing changes).
The browser SDK, CLI, and shared types are **MIT**, and the trust/provenance library is **Apache-2.0**,
so you can embed and build on them freely. A commercial license is available for hosted/OEM use without
AGPL obligations — see **[LICENSING.md](./LICENSING.md)** (licensing@writerslogic.com).
