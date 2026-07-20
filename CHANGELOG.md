# Changelog

All notable changes to Facet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-07-19

Verifiable trust & provenance: a Facet deployment now signs machine-readable statements about itself —
its keys, identity, privacy processing, and build/config state — and can root its signing key in
hardware. Entirely optional and off by default; every analytics feature is unchanged, and Facet stays
strictly cookieless with no cross-session identity. Trust primitives ship in a new Workers-native
`@facet/trust` package (proven to run in real `workerd`); standards that cannot run in Workers ship in
the Node CLI instead. See [docs/trust.md](./docs/trust.md).

### Added

- **Well-known trust documents** — `/.well-known/jwks.json` (signing keys, RFC 7638 `kid`),
  `/.well-known/did.json` (`did:web`), `/.well-known/did-configuration.json` (DIF domain linkage),
  `/.well-known/facet-privacy.json` (W3C DPV privacy manifest), alongside the existing
  `security.txt` (RFC 9116).
- **Signed deployment attestations** — `GET /api/attestation/privacy` returns a W3C VC 2.0
  PrivacyAttestationCredential (`eddsa-jcs-2022` Data Integrity); `GET /api/attestation/evidence`
  returns a RATS process-evidence EAT (build id, commit, schema/config hashes, enabled privacy
  transforms) with an optional `?nonce=` for freshness and challenge-response proof-of-possession of
  the subject key.
- **COSE_Sign1 (RFC 9052)** — real COSE_Sign1 signing/verification over Web Crypto (EdDSA / ES256,
  CBOR via `cborg`), workerd-verified, as a first-class alternative to JWS for signed statements,
  checkpoints, and SCITT statements/receipts (the SCITT / COSE-receipts native wire form).
- **SCITT transparency** — an append-only Merkle Mountain Range log persisted in D1
  (`draft-bryce-cose-receipts-mmr-profile`) with real signed inclusion receipts; local Signed
  Statement registration, plus forwarding to an external service via `SCITT_URL` with returned-receipt
  verification (signature + inclusion proof).
- **Hardware key-attestation** — `key-attributes.hardware` is a verified, conditional claim, never a
  hardcoded boolean: it is `true` only when a key-attestation, checked against a configured trust
  anchor and bound to the subject key, proves the key is hardware-resident and non-extractable
  (HSM / cloud-KMS / YubiKey / TPM). Verified in `workerd` for the native credential; the Node CLI
  (`facet keyattest verify`) validates the X.509 chain real modules emit via `node:crypto`.
- **CLI: signing-key generation** — `facet keys generate [--alg EdDSA|ES256] [--out <file>]` provisions
  the `FACET_SIGNING_JWK` deployment key.
- **CLI: W3C selective disclosure** — `facet sd` implements the `ecdsa-sd-2023` and `bbs-2023`
  cryptosuites (issue → selective reveal → verify). These need RDF canonicalization + BLS12-381 and
  cannot run in Workers (`jsonld` requires `node:https`), so they are Node-CLI-only; inside the Worker,
  Facet uses a Workers-native SD-JWT-style selective disclosure over `eddsa-jcs-2022`.
- **Configuration** — new optional deploy vars/secrets: `FACET_SIGNING_JWK`, `SCITT_URL`,
  `SCITT_TOKEN`, `FACET_SECURITY_CONTACT`, `FACET_SECURITY_POLICY`, `FACET_BUILD_ID`,
  `FACET_GIT_COMMIT`, `FACET_WRANGLER_HASH`. See [self-hosting](./docs/self-hosting.md#trust--provenance-configuration).
- **GPC** — the browser client now honors the Global Privacy Control signal
  (`navigator.globalPrivacyControl`) in addition to Do-Not-Track.

### Notes

- Cloudflare does not expose an isolate runtime / measured-boot self-quote to Worker code, so Facet
  does not attest a measured boot chain of the isolate itself; that is covered from the other side by
  build-time SLSA provenance + a signed config/schema hash, and is kept distinct from hardware rooting
  of the signing key. This boundary is documented, not faked.

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

[0.5.0]: https://github.com/writerslogic/facet/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/writerslogic/facet/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/writerslogic/facet/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/writerslogic/facet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/writerslogic/facet/releases/tag/v0.1.0
