# Changelog

All notable changes to Countless are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-16

Initial public release. Privacy-first, Cloudflare-native web analytics that runs entirely on
Cloudflare Workers + D1.

### Added

- **Ingest** — `POST /api/collect` beacon: payload validation, per-IP rate limiting, bot filtering,
  and cookieless privacy-safe visitor hashing (`SHA-256` of IP + user-agent + daily UTC salt +
  site id). Raw IP is never stored, logged, or returned.
- **Stats API** — `GET /api/stats` (Bearer API key, per-site scoped): summary totals, zero-filled
  time series, and top paths / referrers / custom events / countries / devices.
- **Admin API** — site and API-key management (`/api/sites`, `/api/keys`) behind an `ADMIN_TOKEN`;
  only key hashes are stored, plaintext keys are shown once.
- **Rollups & retention** — hourly/daily aggregation into `event_rollups` and a rolling retention
  window for raw events, driven by a single cron job registry.
- **Dashboard** — React 19 + Vite SPA (KPI cards, uPlot traffic chart, top-list breakdowns) served
  as static assets by the Worker with SPA fallback.
- **Browser client** (`countless` on npm) — zero-dependency tracking snippet with an
  auto-init script tag, SPA navigation tracking, and a `window.umami`-compatible shim.
- **CLI** (`countless-cli` on npm) — `init`, `migrate`, and `stats` commands for self-hosters.
- **Docs** — usage, self-hosting, privacy model, and API reference.

[0.1.0]: https://github.com/OWNER/countless/releases/tag/v0.1.0
