# Changelog

All notable changes to Facet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-07-17

1.0 hardening: privacy controls, ingest resilience, new analytics reads, richer tooling, and a
substantially upgraded dashboard — all still strictly cookieless with no cross-session identity.

### Added

- **Visitor opt-out & Do-Not-Track** — the browser client honors the browser's DNT signal and a
  per-visitor opt-out; ignored visitors are never recorded.
- **Event-endpoint rate limiting** — the first-party `POST /api/event` ingest is now rate-limited
  alongside the public beacon.
- **Internal-event filtering & interactions** — internal/system events (`$exposure`, `form_submit`,
  and any other `$`-prefixed name) are excluded from the custom-events KPI and `top_events`, and
  surfaced separately at the new `GET /api/stats/interactions`.
- **Session-freshness metadata** — `GET /api/stats`, `/api/stats/sessions`, and `/api/stats/channels`
  return a backward-compatible `meta: { materialization: "hourly", pending }` block so callers can
  distinguish "no data" from session-derived analytics that the hourly cron has not materialized yet.
- **CSV / JSON export** — `GET /api/stats/export` streams any time series or top-N breakdown as CSV
  (with `Content-Disposition: attachment`) or JSON. CSV cells are spreadsheet formula-injection-safe.
- **Realtime metric** — `GET /api/stats/realtime` reports active visitors and pageviews over a
  trailing 5-minute window using distinct daily visitor hashes (no cookies or persistent id).
- **Natural-language series intent** — `POST /api/stats/query` intents may set `series: true` with an
  `interval` to return a `result.kind: "series"` trend, in addition to `scalar` and `breakdown`.
- **Experiment client helpers** — `window.facet.whenReady()` resolves once flag config has loaded,
  and `assignment(flag_key)` returns the bucketed variant without firing an exposure.
- **CLI resource commands & config helpers** — `facet` gains admin-API resource groups
  (`sites` / `keys` / `goals` / `funnels` / `experiments`, each with `--json`) plus
  `config set-db-id` and `config check` to write and verify the D1 `database_id` in `wrangler.jsonc`.
- **Generated `wrangler.test.jsonc`** for the test environment, and a CI check that fails on
  placeholder links in the docs.
- **Optional signed anomaly webhook** — when `WEBHOOK_URL` is set the hourly cron delivers each new
  anomaly as a best-effort, time-bounded POST, HMAC-SHA256 signed via `X-Facet-Signature` when
  `WEBHOOK_SECRET` is configured. Added backup and observability documentation.
- **Dashboard upgrades** — an admin **Settings** tab for managing sites and API keys, one-click
  multi-site switching, a realtime panel, an interactions panel, CSV/JSON export controls, refined
  visualizations, and custom date ranges with period-over-period comparison.

### Fixed

- **Anomaly completed-hours** — anomaly detection now scores only completed hourly buckets, so an
  in-progress (partial) current hour no longer registers as a false drop.

## [0.3.0] - 2026-07-16

Advanced analytics: server-side ingest, experiments, anomaly detection, and natural-language query —
all strictly cookieless with no cross-session identity.

### Added

- **First-party server events** — `POST /api/event`, an API-key-authenticated server-to-server
  ingest endpoint. Because events come from your own origin there is no client-side script for
  ad-blockers or content filters to drop. Shares the browser beacon's privacy-safe pipeline (any
  supplied IP is used only to derive the daily hash, never stored). The collect pipeline was
  extracted into a shared `ingestEvent` used by both endpoints.
- **A/B experiments & feature flags** — admin-defined experiments (2–8 weighted variants) with
  privacy-first, **client-side** variant assignment (a random `localStorage` id, never sent as
  identity). `window.facet.variant('flag_key')` buckets locally and fires one aggregate
  `$exposure` event. Results endpoint reports per-variant exposures, distinct-visitor conversions,
  and a two-proportion z-test `p_value` / significance flag vs. the control. New dashboard tab.
- **Anomaly detection & root-cause autopsy** — `GET /api/stats/anomalies` scores the latest hour of
  pageviews against a baseline (z-score), identifies the largest-contributing segment
  (device / country / channel), and returns a plain-language summary. Deterministic (no LLM). New
  dashboard tab.
- **Natural-language query** — `POST /api/stats/query` translates a plain-English question via
  Workers AI into a constrained, validated query intent (never raw SQL), executed over the existing
  aggregate stats helpers. New "Ask" dashboard tab. Requires the `AI` binding; degrades to a clear
  `503 ai_unavailable` without it.
- **Client form-submission tracking** and **auto UTM capture** in the browser snippet.

## [0.2.0] - 2026-07-16

Phase 2/3 features: sessions, traffic channels, goals, conversions, and funnels.

### Added

- **Sessions & engagement** — server-side sessionization folds raw events into sessions
  (30-minute inactivity gap, per UTC day; non-reversible `SHA-256` session id, no raw
  IP/UA). New engagement metrics — session count, bounce rate, pages per session, and
  average duration — surface on `GET /api/stats` (`engagement`) and standalone at
  `GET /api/stats/sessions`.
- **Traffic channels** — each event is classified into paid / email / social / organic /
  direct / internal / referral from its UTM tags and referrer. Channel counts appear on
  `GET /api/stats` (`channels`) and at `GET /api/stats/channels`.
- **UTM capture** — the browser client reads `utm_source` / `utm_medium` / `utm_campaign`
  from the page URL and sends them as `utm` on every beacon; the collect payload accepts
  an optional `utm` object.
- **Goals & conversions** — admin CRUD for site-scoped goals (`POST`/`GET`/`DELETE
  /api/goals`, matching an event `name` or `path`); conversion reports at
  `GET /api/stats/conversions` and a catalog read at `GET /api/stats/goals`.
- **Funnels** — admin CRUD for 2–10-step funnels (`POST`/`GET`/`DELETE /api/funnels`), a
  per-step funnel report with overall completion rate at `GET /api/funnels/:id/report`,
  and a catalog read at `GET /api/stats/funnels`.
- **Client form tracking** — the auto-init script tracks form submissions as a
  `form_submit` event (`form_id` / `form_name` / `action`, no field values); opt out with
  `data-facet-ignore` on the `<form>`.
- **Dashboard** — funnels and conversions views for building/inspecting goals and funnels.

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
- **Browser client** (`@writerslogic/facet` on npm) — zero-dependency tracking snippet with an
  auto-init script tag, SPA navigation tracking, and a `window.umami`-compatible shim.
- **CLI** (`@writerslogic/facet-cli` on npm) — `init`, `migrate`, and `stats` commands for self-hosters.
- **Docs** — usage, self-hosting, privacy model, and API reference.

[0.4.0]: https://github.com/dcondrey/facet/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/dcondrey/facet/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dcondrey/facet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dcondrey/facet/releases/tag/v0.1.0
