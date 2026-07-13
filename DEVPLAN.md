---
status: completed
---

<!-- Deterministic v1 build plan for Countless. Executable by an autonomous coding agent with
     zero human clarification. Every load-bearing decision is pre-resolved. No "TBD", no "choose",
     no "e.g." for anything an implementer must know. Where a value is fixed, it is stated as fixed.
     The Dependency Table near the end is the ONE authoritative ordering. Inline `Txxx` references
     inside skeleton stub comments (e.g. "lands in T007") are indicative only and MUST NOT be
     trusted over this table; update or delete such comments as you implement each file. -->

# Countless — v1 Development Plan

This plan takes the repository from its current compiling skeleton to a shippable v1. Tasks are
numbered `T001…T043`, each a single-responsibility unit that is independently verifiable. Execute in
dependency order (see the **Dependency Table**). Tasks marked **‖ parallel** in a wave have no
ordering constraint between them once their Blocked-by set is satisfied — subject to the
serialization points listed in the **Parallelization Guide**.

v1 scope is locked to: pageviews, custom events, per-hostname privacy-safe uniques, top
paths/referrers, top countries/devices (from Cloudflare request headers), API keys, the dashboard,
and one-command self-host deploy. See **Deferred / Out of Scope** for the hard boundary.

---

## Global Conventions

These apply to **every** task. They are the single source of truth; tasks do not restate them.

- **Language/runtime:** TypeScript only, ESM only (`"type": "module"`). `target ES2022`,
  `moduleResolution: Bundler`, `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`
  (already set in `tsconfig.base.json`). Import local files with explicit `.js` extensions.
- **Package manager:** pnpm 11 workspaces (`packageManager: pnpm@11.12.0`). Never add `npm`/`yarn`
  lockfiles. Native build approvals live in `pnpm-workspace.yaml` under `allowBuilds`
  (`@biomejs/biome`, `esbuild`, `workerd`, `sharp` = `true`). Do not migrate to
  `onlyBuiltDependencies` — pnpm 11 does not honor it for the build gate.
- **Workspace package names (exact — use these in `--filter`):** root `countless-monorepo`;
  `@countless/shared`; `@countless/server`; `@countless/dashboard`; `countless` (client);
  `countless-cli`. The strings `web` and `worker` are **not** valid filters.
- **Lint/format:** Biome 1.9.4. `pnpm lint` (= `biome check .`) must exit 0. Auto-fix with
  `pnpm exec biome check --write .` before committing. Config (already committed in `biome.json`):
  **tab indentation, indent width 4, line width 100**, single quotes, trailing commas, semicolons
  always, LF endings. Do not reformat to spaces.
- **Typecheck:** `pnpm typecheck` (= `pnpm -r typecheck`) must exit 0.
- **Tests:** Vitest. `pnpm test` (= `pnpm -r test`) must exit 0. `@countless/server` runs tests in
  real `workerd` via `@cloudflare/vitest-pool-workers` (D1 + runtime match production). Every task
  that adds logic adds/updates a colocated `*.test.ts` (next to the code, or under the package's
  `test/`). Worker integration tests depend on the migration harness from **T006**.
- **Commit format:** `<type>: <description>` — single line, imperative, no em-dashes.
  `type ∈ fix | feat | refactor | test | docs | perf | security | chore`. One logical unit per
  commit; reference the task id in the body (e.g. `feat: collect endpoint (T014)`).
- **Definition of Done (per task):** (1) `pnpm typecheck` = 0; (2) `pnpm lint` = 0; (3) `pnpm test`
  = 0; (4) the task's explicit Completion criteria are met and machine-verified by the named test(s)
  or command(s); (5) no `TODO`/`FIXME`/`console.log`/debug code left behind (structured logging via
  the T031 logger is exempt); (6) one commit in the specified format.
- **No scope creep.** Do not implement anything under **Deferred / Out of Scope**. If a task tempts
  expansion, stop at its Completion criteria.

### Canonical constants (fixed values — never guess)

Server-only constants live in `apps/server/src/lib/constants.ts` (created in **T004**). Wire-level
validation limits live in `packages/shared/src/schemas.ts` (**T002**).

| Name | Value | Where | Meaning |
| --- | --- | --- | --- |
| `HASH_DELIMITER` | `'\x1f'` (ASCII Unit Separator) | server constants | Field separator inside the visitor-hash preimage. Cannot occur in IPs/UAs/UUIDs/hex, so no collision or injection. |
| `SALT_BYTES` | `32` | server constants | Random bytes per daily salt (→ 64 hex chars). |
| `API_KEY_PREFIX` | `'clk_'` | server constants | Plaintext API-key prefix. |
| `API_KEY_BYTES` | `32` | server constants | Random bytes in an API key (→ 64 hex; full key length 68). |
| `COLLECT_MAX_BODY_BYTES` | `8192` | server constants | Hard body-size cap on `POST /api/collect`. Over → 413. |
| `RATE_LIMIT` | `{ limit: 100, period: 60 }` | server constants + wrangler | 100 requests / 60 s per client IP on `/api/collect`. |
| `DEFAULT_RETENTION_DAYS` | `90` | server constants | Fallback when `RAW_RETENTION_DAYS` var is missing/NaN. |
| `HOUR_MS` | `3_600_000` | server constants | Hour bucket width. |
| `DAY_MS` | `86_400_000` | server constants | Day bucket width + retention day unit. |
| `MAX_RANGE_DAYS` | `90` | server constants | Max `end - start` accepted by `/api/stats`. Over → 400 `range_too_large`. |
| `PROPS_MAX_KEYS` | `24` | shared schema | Max keys in a custom-event `props` object. |
| `PROPS_KEY_MAX_LEN` | `40` | shared schema | Max length of a `props` key. |
| `PROPS_STR_MAX_LEN` | `500` | shared schema | Max length of a string `props` value. |

### Canonical contracts

- **Visitor hash:** `SHA-256(ip ⧊ userAgent ⧊ dailySalt ⧊ siteId)` where `⧊` = `HASH_DELIMITER`
  and the field order is exactly `ip, userAgent, dailySalt, siteId`. UTF-8 encode, digest with
  `crypto.subtle.digest('SHA-256', …)`, return **lowercase hex, 64 chars**. `ip` =
  `CF-Connecting-IP` header. Raw IP is **never** stored, logged, or returned.
- **Salt rotation:** one salt per **UTC** day. `dayKey = 'YYYY-MM-DD'` derived from a millisecond
  timestamp in UTC. Salt = `SALT_BYTES` random bytes, lowercase hex, created lazily on the first
  event of the day via `INSERT OR IGNORE` then re-select (race-safe). At a UTC midnight boundary the
  salt changes, so the same human produces a different hash the next day — this is intentional:
  **uniqueness is scoped to one UTC day**, and cross-day re-identification is cryptographically
  prevented. Do not "fix" this, and specifically **do not add any multi-salt lookback** (e.g.
  "compare against yesterday's salt to detect returning visitors"): it cannot work without persisting
  raw IP/UA, which is forbidden. `salts` retains prior days' salts only so historical raw events in
  the retention window remain internally consistent — never to re-link a visitor across days.
- **Uniques semantics (fixed):** `visitors` for a range = `COUNT(DISTINCT visitor_hash)` over raw
  `events` in that range. Because the hash rotates daily, a visitor returning on N distinct UTC days
  counts N times across a multi-day range. This is the documented, intended definition of "unique
  visitors" for Countless. State it in `docs/privacy.md`; never store anything that would allow
  cross-day linkage.
- **Time:** all timestamps are unix epoch **milliseconds** (`Date.now()`), stored as SQLite
  `INTEGER`. `StatsQuery.start` is **inclusive**, `StatsQuery.end` is **exclusive**.
- **Auth:** stats endpoints require `Authorization: Bearer <api_key>`; a key is scoped to exactly
  one `site_id`. Admin endpoints (site + key management) require
  `Authorization: Bearer <ADMIN_TOKEN>` where `ADMIN_TOKEN` is a Worker **secret**
  (`wrangler secret put ADMIN_TOKEN`), not a var. Only key/token **hashes** are ever compared; only
  key **hashes** are ever stored.
- **CORS:** `POST /api/collect` and its `OPTIONS` preflight allow any origin
  (`Access-Control-Allow-Origin: *`, `Allow-Methods: POST, OPTIONS`, `Allow-Headers: content-type`,
  `Max-Age: 86400`). Preflight returns **204**. Stats and admin endpoints set **no** permissive CORS
  (the dashboard is served same-origin by the Worker).
- **Error responses (canonical):** every error is `Content-Type: application/json` with body
  `{ "error": <code>, "message"?: string, "issues"?: unknown }`. `code` is one of the fixed set
  below; validation failures include valibot `issues`.

| `error` code | HTTP | Emitted when |
| --- | --- | --- |
| `validation_failed` | 400 | Request body/query fails its valibot schema (includes `issues`). |
| `bad_request` | 400 | Semantically invalid but schema-valid input. |
| `bad_range` | 400 | `/api/stats` with `end <= start`. |
| `range_too_large` | 400 | `/api/stats` with `end - start > MAX_RANGE_DAYS`. |
| `payload_too_large` | 413 | `/api/collect` body exceeds `COLLECT_MAX_BODY_BYTES`. |
| `unauthorized` | 401 | Missing/malformed `Authorization` header. |
| `invalid_api_key` | 401 | Bearer API key not found. |
| `invalid_admin_token` | 401 | Admin bearer token mismatch. |
| `site_mismatch` | 403 | Valid key, but `query.site_id` ≠ the key's site. |
| `not_found` | 404 | Unknown route or missing resource. |
| `rate_limited` | 429 | Rate-limit binding denied (adds `Retry-After: 60`). |
| `internal_error` | 500 | Uncaught error (via `app.onError`). Never leaks internals. |

### Shared & reusable code (DRY mandate)

Duplicated logic is a Definition-of-Done failure. Every task **must reuse** the canonical modules
below and **must not** re-implement their behavior inline. Each module has one owning task that
creates it; all later tasks import it. Adding a second implementation of any canonical concern (a
second hex encoder, a second beacon sender, a second WHERE-builder, a second admin-CRUD block) fails
review even if tests pass.

**Server canonical modules:**

| Module | Exports (canonical API) | Owner task | Reused by |
| --- | --- | --- | --- |
| `apps/server/src/lib/crypto.ts` | `sha256Hex(input)`, `randomHex(bytes)`, `toHex(bytes)`, `constantTimeEqualHex(a,b)` | **T009** | salt (T008), apikeys (T018), auth (T019), sessions id (T048), bucketing (T069), author hash (T092) |
| `apps/server/src/lib/http.ts` | `ApiError`, `badRequest/unauthorized/forbidden/tooManyRequests/notFoundError`, `toErrorBody` | **T007** | every route + middleware |
| `apps/server/src/routes/registry.ts` | `ROUTES: { path, router }[]`; `app.ts` iterates it | **T007** | every route task appends one entry (no `app.ts` edits after T007) |
| `apps/server/src/lib/crud.ts` | `crudRouter({ table, schema, siteScoped })` → a Hono router with POST/GET/DELETE-by-site | **T020** | goals (T055), funnels (T058), experiments (T070), sources (T096) |
| `apps/server/src/db/queries.ts` | `db(env)` schema-bound Drizzle client | v1 skeleton | all D1 access (never call `drizzle()` directly elsewhere) |
| `apps/server/src/db/filters.ts` | `buildEventWhere(f)`, `buildSessionWhere(f)` (site/hostname/path/country/device/channel/time predicates) | **T021** | stats (T021/T049), conversions (T057), funnels (T059), filtered stats (T082) |
| `apps/server/src/lib/scheduled.ts` | `registerJob(job)` → `JOBS: ScheduledJob[]`; `runScheduled` iterates with per-job try/catch | **T032** | rollups+retention (T032), sessions (T048), insights (T088b), social poll (T093b) |
| `apps/server/src/lib/ai.ts` | `classifySentiment(env,text)`, `embed(env,text)`, `summarize(env,prompt)` (pinned model ids in one place) | **T086** | insights (T088b), social scoring (T094a/b) |
| `apps/server/src/lib/log.ts` | `createLogger` (JSON lines, `ip`-stripping) | **T031** | every module that logs |
| `apps/server/test/fixtures.ts` | `seedSite`, `seedEvents`, `seedSessions`, … | **T006** (+ each phase extends its own seeder) | every Worker integration test |

**Client canonical modules (`packages/client/src/`):**

| Module | Exports | Owner | Reused by |
| --- | --- | --- | --- |
| `transport.ts` | `send(host, payload)` — `sendBeacon` with `fetch(keepalive)` fallback, JSON Blob | **T015** | track (T015), perf (T063), experiments (T071) |
| `config.ts` | module-scoped `{ host, siteId }` store + `getConfig()` | **T015** | all client entrypoints |

**Dashboard canonical modules (`apps/dashboard/src/`):**

| Module | Exports | Owner | Reused by |
| --- | --- | --- | --- |
| `api.ts` | `apiFetch<T>(path, apiKey)` base fetch (bearer header, error mapping) | **T024** | every feature fetcher — no bespoke `fetch` in components |
| `hooks/` (per-feature files + `hooks/index.ts` barrel) | `useStats`, `useSessions`, `useConversions`, … one file per feature | **T024** creates the folder + barrel | each dashboard task adds its own `hooks/<feature>.ts` (avoids the `hooks.ts` merge conflict) |
| `lib/cn.ts` | `cn(...)` = `twMerge(clsx(...))` | **T023** | every component |
| `components/TopList.tsx` | Plausible-style `CountRow[]` bars | **T027** | channels (T051), clusters (T097), any ranked list |
| `components/EChart.tsx` | ECharts wrapper | **T081a** | funnels (T060), sentiment (T097), any advanced viz |

**Shared contract:** `@countless/shared` is the only home for wire types + valibot schemas; server,
client, dashboard, and CLI import from it and never redeclare a payload/response shape.

**DoD addendum (duplication check):** before committing, confirm the task imports the relevant
canonical module(s) above and introduced no parallel implementation. Note in the DRY table above that
`hooks/` is a **folder of per-feature files**, not a single `hooks.ts` — this is deliberate so
parallel dashboard tasks never collide on one file.

### Secrets & environment (fixed — the agent must not guess)

- **Single environment for v1.** Do **not** add wrangler `[env.production]` / `[env.preview]`
  stanzas or `--env` flags. There is exactly one Worker config (`wrangler.jsonc`) with the top-level
  bindings. Local vs remote differ only by the `--local` / `--remote` flag on
  `wrangler d1 migrations apply` (already the `migrate:local` / `migrate:remote` scripts).
- **`database_id` placeholder.** `wrangler.jsonc` ships `"database_id": "PLACEHOLDER_D1_DATABASE_ID"`.
  This is intentional and must stay: Miniflare/pool-workers tests ignore it (they use a local
  simulated D1), and self-hosters replace it after `wrangler d1 create countless` (documented in
  T039). The agent must not invent a real id.
- **`ADMIN_TOKEN` lifecycle across the three contexts (the only secret in v1):**
  - **Tests** — injected as a Miniflare binding `ADMIN_TOKEN: 'test-admin-token'` in
    `apps/server/vitest.config.ts` (T006). Tests never call `wrangler secret`.
  - **Local dev** — read from `apps/server/.dev.vars` (git-ignored), key `ADMIN_TOKEN=<hex>`.
    `T004`/`T039` add a committed `apps/server/.dev.vars.example` documenting the exact keys
    (`ADMIN_TOKEN=`), and `.dev.vars` is added to `.gitignore`. `countless init` (T034) writes a
    real `.dev.vars` for downstream users.
  - **Production** — `wrangler secret put ADMIN_TOKEN` (interactive; a human/CI step, never invoked
    from code or tests). Documented in T039 self-hosting.
- **npm publish credentials** are supplied only in CI via the `NPM_TOKEN` GitHub secret →
  `NODE_AUTH_TOKEN` (T042). The agent must never hardcode, echo, or commit a token; the release
  workflow fails fast if the secret is absent (T042).
- **Closed schema (no unrequested columns).** The D1 schema is exactly the six tables and columns in
  T003. The agent must **not** add columns an intuition suggests are "standard" — no `source_ip`,
  `raw_ip`, `ip`, `browser_version`, `os`, `screen`, `utm_*`, `indexed_at`, `updated_at`, or any PII
  or raw-metadata column. Any column not defined in T003's schema table is **forbidden** in v1; a new
  column requires a future design pass, not an autonomous decision.

### Locked dependency decisions (do not substitute)

Versions are pinned exactly; upgrade only via a dedicated `chore`. **T005** reconciles the two
version drifts currently in the repo (see that task).

| Concern | Choice | Version | Rationale |
| --- | --- | --- | --- |
| Worker router | `hono` | 4.6.14 | Tiny, fast, first-class Workers support. Uses built-in `hono/cors` + `hono/body-limit` (no extra deps). |
| Worker tooling | `wrangler` + `@cloudflare/workers-types` | 4.0.0 / 4.20250712.0 | v4 CLI; `compatibility_date=2026-07-01`; `deploy --minify`. Version pinned identically at root and in `@countless/server` (T005). |
| D1 access | `drizzle-orm` + `drizzle-kit` | 0.38.3 / 0.30.1 | Zero-runtime typed queries; `drizzle-kit generate` emits D1 SQL from `schema.ts`. |
| Request validation | `valibot` + `@hono/valibot-validator` | 1.0.0 / 0.5.2 | Tree-shakeable; schemas live in `@countless/shared` as the single wire contract. |
| Bot detection | `isbot` | 5.1.28 | Maintained crawler-UA list; the authoritative bot source for v1. |
| IDs | `crypto.randomUUID()` (native) | — | No dependency. |
| Hashing / salt / keys | Web Crypto `crypto.subtle` + `crypto.getRandomValues` (native) | — | No dependency. |
| Rate limiting | Cloudflare native **Rate Limiting binding** (`ratelimit`) | — | 100% Cloudflare-native, no store/deps. |
| Dashboard data | `@tanstack/react-query` | 5.62.11 | Caching, dedupe, background refetch. |
| Dashboard charts | `uplot` | 1.6.31 | 45 KB canvas time-series; top-lists use pure CSS bars (no chart lib). |
| Dashboard styling | `tailwindcss` + `@tailwindcss/vite` + `tailwind-merge` + `class-variance-authority` + `clsx` | 4.0.0 / 4.0.0 / 2.6.0 / 0.7.1 / 2.1.1 | v4 Vite plugin (no PostCSS); the shadcn/ui variant foundation. |
| Icons | `lucide-react` | 0.469.0 | Tree-shakeable SVG icons. |
| Date math | `date-fns` | 4.1.0 | Tree-shakeable, immutable. |
| Dashboard tests | `@testing-library/react` + `@testing-library/jest-dom` + `jsdom` | 16.1.0 / 6.6.3 / 25.0.1 | Standard React component testing. |
| Client bundler | `tsup` | 8.3.5 | esbuild-based ESM + `.d.ts` + IIFE; zero runtime deps shipped. |
| CLI prompts/color | `@clack/prompts` + `picocolors` | 0.9.1 / 1.1.1 | Modern prompts; args via native `util.parseArgs`; HTTP via native `fetch`. |

### Package name & publishing decisions (locked)

- `packages/client` publishes to npm as **`countless`** (default programmatic export `track`).
- `packages/cli` publishes to npm as **`countless-cli`**, `bin.countless`, run as `npx countless-cli`.
- `apps/server` and `apps/dashboard` are private, distributed via the GitHub repo + Deploy to
  Cloudflare button. No PyPI / Homebrew / crates.io.
- **Version strategy (v1):** both public packages and the repo carry the same semver, starting at
  **`0.1.0`** for the v1 release. `CHANGELOG.md` is Keep-a-Changelog format (T041). Releases are cut
  by pushing a `vX.Y.Z` tag (T042).

---

## Wave 0 — Foundations, config hygiene, test harness

### T001 — Shared event, stats, and error types ‖ parallel
- **Description:** Lock the TypeScript interfaces consumed by every package.
- **Files:** `packages/shared/src/events.ts`, `packages/shared/src/stats.ts`.
  (`packages/shared/src/index.ts` already re-exports all three modules; do not edit it.)
- **Pre-decided details:** Keep existing `CollectPayload`, `EventProps`, `PropValue`, `EventKind`,
  `StoredEvent` in `events.ts`; keep `Interval`, `StatsQuery`, `StatsSummary`, `CountRow`,
  `SeriesPoint`, `StatsResponse` in `stats.ts`. **Add to `events.ts`:**
  `interface Site { id: string; name: string; domain: string; created_at: number }` and
  `interface ApiKeyRecord { id: string; site_id: string; label: string | null; created_at: number; last_used: number | null }`
  (note: `ApiKeyRecord` never carries the plaintext key or the hash). **Extend `StatsResponse` in
  `stats.ts`** with `top_countries: CountRow[]` and `top_devices: CountRow[]`. **Add an error type**
  `interface ApiError { error: string; message?: string; issues?: unknown }` to `stats.ts` and
  export it. No runtime code in these files.
- **Completion:** `pnpm typecheck` = 0; `Site`, `ApiKeyRecord`, `ApiError` importable from
  `@countless/shared`; `StatsResponse` includes `top_countries` and `top_devices`.

### T002 — Shared valibot schemas, limits, and derived types ‖ parallel
- **Description:** Make `@countless/shared` the single validation source of truth, with all wire
  limits fixed.
- **Files:** `packages/shared/src/schemas.ts`, `packages/shared/test/schemas.test.ts` (new).
- **Pre-decided details:** Define and export exactly:
  - `PropValueSchema = v.union([v.pipe(v.string(), v.maxLength(PROPS_STR_MAX_LEN)), v.pipe(v.number(), v.finite()), v.boolean(), v.null()])`.
  - `PropsSchema = v.pipe(v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(PROPS_KEY_MAX_LEN)), PropValueSchema), v.check((o) => Object.keys(o).length <= PROPS_MAX_KEYS, 'too_many_props'))`.
  - `CollectPayloadSchema = v.object({ site_id: v.pipe(v.string(), v.uuid()), hostname: v.pipe(v.string(), v.minLength(1), v.maxLength(253)), path: v.pipe(v.string(), v.minLength(1), v.maxLength(2048), v.regex(/^\//, 'path_must_be_absolute')), referrer: v.pipe(v.string(), v.maxLength(2048)), name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))), props: v.optional(PropsSchema) })`.
  - `StatsQuerySchema = v.object({ site_id: v.pipe(v.string(), v.uuid()), hostname: v.optional(v.pipe(v.string(), v.maxLength(253))), start: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)), end: v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)), interval: v.optional(v.picklist(['hour', 'day'])) })`.
  - `CreateSiteSchema = v.object({ name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)), domain: v.pipe(v.string(), v.minLength(1), v.maxLength(253)) })`.
  - `IssueKeySchema = v.object({ site_id: v.pipe(v.string(), v.uuid()), label: v.optional(v.pipe(v.string(), v.maxLength(100))) })`.
  - The constants `PROPS_MAX_KEYS = 24`, `PROPS_KEY_MAX_LEN = 40`, `PROPS_STR_MAX_LEN = 500` are
    declared and exported at the top of this file.
  - Export derived types: `type CollectInput = v.InferOutput<typeof CollectPayloadSchema>`,
    `type StatsQueryInput = v.InferOutput<typeof StatsQuerySchema>`,
    `type CreateSiteInput = v.InferOutput<typeof CreateSiteSchema>`,
    `type IssueKeyInput = v.InferOutput<typeof IssueKeySchema>`.
- **Completion:** `packages/shared/test/schemas.test.ts` passes and asserts: a valid collect payload
  parses; a payload with a non-UUID `site_id` throws; a `name` of 129 chars throws; a `path` without
  a leading `/` throws; `props` with 25 keys throws; a `props` string value of 501 chars throws; and
  a type-level `expectTypeOf<CollectInput>().toMatchTypeOf<CollectPayload>()` holds.

### T003 — Drizzle schema → generated D1 migration
- **Description:** Lock the schema and indexes. `apps/server/src/db/schema.ts` (Drizzle) is the
  source of truth; the SQL migration is **generated**, never hand-edited.
- **Files:** `apps/server/src/db/schema.ts`, `apps/server/drizzle.config.ts`,
  `apps/server/migrations/0001_init.sql`.
- **Pre-decided details:** The scaffolded tables are canonical and already correct; verify columns,
  types, defaults, PKs, and indexes match the table below exactly, then regenerate. Column names are
  snake_case in SQL, camelCase in Drizzle.
  - `sites`: `id TEXT PK`, `name TEXT NOT NULL`, `domain TEXT NOT NULL`, `created_at INTEGER NOT NULL`.
  - `events`: `id TEXT PK`, `site_id TEXT NOT NULL`, `hostname TEXT NOT NULL`, `path TEXT NOT NULL`,
    `referrer TEXT NOT NULL DEFAULT ''`, `name TEXT` (NULL ⇒ pageview), `props TEXT` (JSON string or
    NULL), `visitor_hash TEXT NOT NULL`, `country TEXT`, `device TEXT`, `created_at INTEGER NOT NULL`.
    Indexes: `idx_events_site_created_name (site_id, created_at, name)`,
    `idx_events_site_host_created (site_id, hostname, created_at)`.
  - `event_rollups`: `site_id`, `hostname`, `bucket_start INTEGER`, `interval TEXT`,
    `pageviews INTEGER NOT NULL DEFAULT 0`, `events INTEGER NOT NULL DEFAULT 0`,
    `visitors INTEGER NOT NULL DEFAULT 0`; PK `(site_id, hostname, bucket_start, interval)`.
  - `sessions`: `site_id`, `visitor_hash`, `day_key TEXT`, `first_seen INTEGER NOT NULL`;
    PK `(site_id, visitor_hash, day_key)`.
  - `salts`: `day_key TEXT PK`, `salt TEXT NOT NULL`, `created_at INTEGER NOT NULL`.
  - `api_keys`: `id TEXT PK`, `site_id TEXT NOT NULL`, `key_hash TEXT NOT NULL UNIQUE`, `label TEXT`,
    `created_at INTEGER NOT NULL`, `last_used INTEGER`; index `idx_apikeys_site (site_id)`.
  - Run `pnpm --filter @countless/server db:generate` (which is `drizzle-kit generate`); commit the
    emitted `migrations/0001_init.sql` and its `migrations/meta` journal. The committed SQL must be
    byte-identical to a fresh generation (no hand edits).
  - **Closed schema — this table is the complete and final v1 column set.** Do not add any column
    beyond those listed above (see the "Closed schema" rule in Global Conventions). In particular, no
    raw-IP, browser-version, OS, UTM, or `*_at` audit columns. A schema-widening idea is out of scope.
- **Completion:** re-running `db:generate` produces **no diff** in `migrations/`; the T006 harness
  applies the migration and a test asserts `SELECT name FROM sqlite_master WHERE type='table'` lists
  all six tables (`sites`, `events`, `event_rollups`, `sessions`, `salts`, `api_keys`); a test also
  asserts `events` has exactly the 11 defined columns via `PRAGMA table_info(events)` (guards against
  an accidentally added column).

### T004 — Worker Env, constants, wrangler bindings, generated types
- **Description:** Wire all runtime bindings/vars, add the constants module, and generate the
  ambient Worker types file that Biome and tsc expect.
- **Files:** `apps/server/src/env.ts`, `apps/server/src/lib/constants.ts` (new),
  `apps/server/wrangler.jsonc`, `apps/server/worker-configuration.d.ts` (new, generated),
  `apps/server/.dev.vars.example` (new), `.gitignore`.
- **Pre-decided details:**
  - `Env` = `{ DB: D1Database; ASSETS: Fetcher; RATE_LIMITER: RateLimit; RAW_RETENTION_DAYS: string; ADMIN_TOKEN: string }`.
    `RateLimit` comes from `@cloudflare/workers-types`; if the installed version lacks it, declare a
    minimal `interface RateLimit { limit(opts: { key: string }): Promise<{ success: boolean }> }` in
    `worker-configuration.d.ts`.
  - `constants.ts` exports every value in the **Canonical constants** table that is marked "server
    constants".
  - In `wrangler.jsonc`, add the native rate-limit binding:
    `"unsafe": { "bindings": [{ "name": "RATE_LIMITER", "type": "ratelimit", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } }] }`.
    Keep the existing `DB`, `ASSETS`, cron `0 * * * *`, `vars.RAW_RETENTION_DAYS = "90"`, and the
    commented post-v1 bindings block unchanged. `ADMIN_TOKEN` stays a secret (documented in T039), not
    a var.
  - Generate `worker-configuration.d.ts` via `wrangler types` (or hand-write the equivalent ambient
    module) so the `worker-configuration.d.ts` glob already referenced by `biome.json` resolves.
  - Add `apps/server/.dev.vars.example` containing exactly `ADMIN_TOKEN=` (documented placeholder for
    local dev), and add `apps/server/.dev.vars` (real, git-ignored) to the root `.gitignore`.
- **Completion:** `pnpm --filter @countless/server typecheck` = 0; `wrangler deploy --dry-run`
  parses the config without error; `worker-configuration.d.ts` exists and `pnpm lint` = 0;
  `.dev.vars.example` is committed and `.gitignore` excludes `.dev.vars`.

### T005 — Fix root/workspace scripts and reconcile pinned versions
- **Description:** The root `package.json` currently has broken script filters and a version drift
  that will misfire under an autonomous run. Fix them so every documented command works verbatim.
- **Files:** root `package.json`, `apps/server/package.json`.
- **Pre-decided details (each is a concrete replacement):**
  - `dev:web`: `pnpm --filter web dev` → `pnpm --filter @countless/dashboard dev`.
  - `dev:worker`: `pnpm --filter worker dev` → `pnpm --filter @countless/server dev`.
  - `deploy`: `pnpm --filter worker deploy` → `pnpm --filter @countless/server deploy`.
  - `db:generate`: `pnpm --filter worker drizzle-kit generate:sqlite` →
    `pnpm --filter @countless/server db:generate`.
  - `db:migrate`: `pnpm --filter worker wrangler d1 migrations apply countless_db` →
    `pnpm --filter @countless/server migrate:local` (database name is `countless`, not `countless_db`).
  - `build`: keep `pnpm -r build`, but ensure ordering: the dashboard must build before the server is
    served/deployed. Add root `"build": "pnpm --filter @countless/dashboard build && pnpm -r --filter '!@countless/dashboard' build"`.
  - Pin `@cloudflare/workers-types` to **`4.20250712.0`** (exact, no caret) at root **and** in
    `apps/server/package.json` (currently `4.20250109.0`). Pin root `wrangler` to `4.0.0` (drop the
    caret).
- **Completion:** `pnpm -r typecheck` = 0; `pnpm build` completes; `pnpm --filter @countless/server db:generate`
  runs; `pnpm install --frozen-lockfile` still succeeds (regenerate the lockfile in the same commit
  if the version pins changed it). No `package.json` script references `web`, `worker`, or
  `countless_db`.

### T006 — Worker test harness: D1 migrations, env typing, fixtures
- **Description:** Establish how every Worker integration test gets a migrated D1 and typed bindings.
  Nothing downstream can be tested without this.
- **Files:** `apps/server/vitest.config.ts`, `apps/server/test/apply-migrations.ts` (new),
  `apps/server/test/env.d.ts` (new), `apps/server/test/fixtures.ts` (new),
  `apps/server/test/harness.test.ts` (new).
- **Pre-decided details:**
  - `vitest.config.ts`: use the async form of `defineWorkersConfig`; call
    `readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)))` and pass the result as
    a Miniflare binding `TEST_MIGRATIONS`; also set `bindings: { ADMIN_TOKEN: 'test-admin-token' }`
    and `RAW_RETENTION_DAYS: '90'`; keep `wrangler: { configPath: './wrangler.jsonc' }`; set
    `setupFiles: ['./test/apply-migrations.ts']`, `poolOptions.workers.isolatedStorage: true`,
    `singleWorker: true`.
  - `test/apply-migrations.ts`: `import { applyD1Migrations, env } from 'cloudflare:test';` then
    `await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);` (top-level await; runs once per isolate).
  - `test/env.d.ts`: augment `declare module 'cloudflare:test' { interface ProvidedEnv extends Env { TEST_MIGRATIONS: D1Migration[] } }`
    (import `Env` from `../src/env.js`).
  - `test/fixtures.ts`: pure, dependency-free helpers reused by integration tests —
    `seedSite(env, overrides?)`, `seedEvents(env, { siteId, count, hostname, path, referrer, name, device, country, spanMs })`,
    each inserting deterministic rows with a fixed base timestamp passed in by the caller (no
    `Date.now()` inside fixtures, so tests are reproducible).
  - **Rate-limit binding note:** Miniflare does not reliably emulate the `ratelimit` type. The T013
    middleware is therefore written to **no-op when `env.RATE_LIMITER` is absent**, and integration
    tests run without it. Rate limiting is unit-tested in isolation (T013). Do not attempt to fake a
    `ratelimit` binding in Miniflare.
- **Completion:** `apps/server/test/harness.test.ts` passes and asserts that inside a
  `cloudflare:test` `env`, `SELECT count(*) FROM sqlite_master WHERE type='table'` returns 6, and
  `seedSite` + `seedEvents` insert and read back the expected row counts.

### T007 — Hono app shell: error conventions, CORS, body limit, 404
- **Description:** Harden the app factory to the canonical error/CORS conventions.
- **Files:** `apps/server/src/app.ts`, `apps/server/src/lib/http.ts` (new),
  `apps/server/src/routes/registry.ts` (new, canonical — see DRY mandate),
  `apps/server/test/app.test.ts` (new).
- **Pre-decided details:**
  - `routes/registry.ts` exports `ROUTES: { path: string; router: Hono<{ Bindings: Env }> }[]`
    (initially the health/collect/stats entries). `app.ts` iterates `ROUTES` to mount everything, so
    **new route tasks append one entry to `registry.ts` and never edit `app.ts`** (removes the
    `app.ts` serialization chain). `app.onError`/`notFound`/cors/bodyLimit stay in `app.ts`.
  - `http.ts`: `class ApiError extends Error { constructor(public code: string, public status: number, message?: string, public issues?: unknown) }`; helpers
    `badRequest(code='bad_request', msg?)`, `unauthorized(code='unauthorized', msg?)`,
    `forbidden(code='site_mismatch', msg?)`, `tooManyRequests()`, `notFoundError()`; a
    `toErrorBody(err): ApiError-shaped JSON`.
  - `app.ts`: `app.onError` maps `ApiError` → `c.json({ error: err.code, message: err.message, issues: err.issues }, err.status)`; any other error → `c.json({ error: 'internal_error' }, 500)` (never leak the message). `app.notFound` → `c.json({ error: 'not_found' }, 404)`. Apply `cors()` from `hono/cors` scoped to `/api/collect` with `origin: '*'`, `allowMethods: ['POST', 'OPTIONS']`, `allowHeaders: ['content-type']`, `maxAge: 86400`. Apply `bodyLimit({ maxSize: COLLECT_MAX_BODY_BYTES, onError: () => { throw new ApiError('payload_too_large', 413); } })` from `hono/body-limit` scoped to `/api/collect`. Keep `GET /api/health` → `{ ok: true }`.
- **Completion:** `app.test.ts` passes and asserts: `GET /api/health` → 200 `{ ok: true }`;
  `GET /api/nope` → 404 `{ error: 'not_found' }`; `OPTIONS /api/collect` → 204 with
  `Access-Control-Allow-Origin: *`; a `POST /api/collect` body larger than 8192 bytes → 413
  `{ error: 'payload_too_large' }`.

---

## Wave 1 — Ingest pipeline + browser client

### T008 — Daily salt management ‖ parallel
- **Files:** `apps/server/src/lib/salt.ts`, `apps/server/test/salt.test.ts` (new).
- **Pre-decided details:** `dayKey(nowMs: number): string` → UTC `YYYY-MM-DD` (zero-padded).
  `getDailySalt(env: Env, dayKey: string): Promise<string>`: `SELECT salt FROM salts WHERE day_key=?`;
  if absent, generate `SALT_BYTES` random bytes via `crypto.getRandomValues`, lowercase-hex encode,
  `INSERT OR IGNORE INTO salts (day_key, salt, created_at) VALUES (?,?,?)` with `created_at =` the ms
  timestamp the caller passes (add a `now: number` parameter), then re-select and return the stored
  value (race-safe).
- **Completion:** `salt.test.ts` (workers pool, real D1) asserts: two calls with the same `dayKey`
  return the identical 64-hex salt and exactly one `salts` row exists; a different `dayKey` yields a
  different salt; `dayKey(0)` === `'1970-01-01'`.

### T009 — Crypto primitives + visitor hash ‖ parallel
- **Files:** `apps/server/src/lib/crypto.ts` (new, canonical — see DRY mandate),
  `apps/server/src/lib/hash.ts`, `apps/server/test/crypto.test.ts` (new),
  `apps/server/test/hash.test.ts` (new).
- **Pre-decided details:** `crypto.ts` is the single source for encoding/digests, exporting
  `toHex(bytes: Uint8Array): string`, `sha256Hex(input: string): Promise<string>` (UTF-8 →
  `crypto.subtle.digest('SHA-256')` → hex), `randomHex(bytes: number): string`
  (`crypto.getRandomValues`), and `constantTimeEqualHex(a: string, b: string): boolean` (length-safe
  compare). No other module may re-implement hex/sha256/random-hex. `visitorHash(ip, userAgent, dailySalt, siteId): Promise<string>`
  = `sha256Hex([ip, userAgent, dailySalt, siteId].join(HASH_DELIMITER))`. Pure, no I/O; never logs `ip`.
- **Completion:** `crypto.test.ts` asserts `sha256Hex('')` equals the known SHA-256-of-empty digest,
  `randomHex(32)` is 64 hex chars and varies, and `constantTimeEqualHex` is correct; `hash.test.ts`
  asserts `visitorHash` output is 64 lowercase hex, is deterministic, changes when any argument
  changes, and matches a pinned digest for a fixed 4-tuple.

### T010 — Bot filtering ‖ parallel
- **Files:** `apps/server/src/lib/bots.ts`, `apps/server/test/bots.test.ts` (new).
- **Pre-decided details:** `isBot(userAgent: string): boolean` = `isbot(userAgent)` from `isbot`;
  additionally return `true` when `userAgent` is empty or whitespace-only. `isbot` is the sole
  bot-list source for v1.
- **Completion:** `bots.test.ts` asserts `isBot('Googlebot/2.1')` and `isBot('')` and `isBot('   ')`
  are `true`; a normal desktop Chrome UA is `false`.

### T011 — Request metadata (ip, country, device) ‖ parallel
- **Files:** `apps/server/src/lib/request-meta.ts` (new), `apps/server/test/request-meta.test.ts` (new).
- **Pre-decided details:** `clientIp(req: Request): string` = `req.headers.get('CF-Connecting-IP') ?? ''`.
  `country(req: Request): string | null` = uppercased `req.cf?.country ?? req.headers.get('CF-IPCountry')`;
  map `'XX'` and `'T1'` (Tor) to `null`; empty → `null`. `device(userAgent: string): 'mobile' | 'tablet' | 'desktop'`:
  test `/\bipad\b|\btablet\b/i` → `'tablet'`; else `/\b(mobi|android|iphone)\b/i` → `'mobile'`; else
  `'desktop'`.
- **Completion:** `request-meta.test.ts` asserts device for iPhone/iPad/desktop UAs; `country`
  uppercases `'us'` → `'US'`, maps `'T1'` → `null`; `clientIp` returns the header value or `''`.

### T012 — Event insert + session upsert queries ‖ parallel
- **Files:** `apps/server/src/db/queries.ts`, `apps/server/test/queries.test.ts` (new).
- **Pre-decided details:** Keep the existing `db(env)` Drizzle client. Define
  `interface NewEvent { siteId: string; hostname: string; path: string; referrer: string; name: string | null; props: EventProps | null; visitorHash: string; country: string | null; device: string | null; createdAt: number }`.
  `insertEvent(env: Env, row: NewEvent): Promise<string>`: `const id = crypto.randomUUID();`
  `db(env).insert(schema.events).values({ ...row, id, props: row.props ? JSON.stringify(row.props) : null })`;
  return `id`. `upsertSession(env: Env, siteId: string, visitorHash: string, dayKey: string, firstSeen: number): Promise<void>`:
  `db(env).insert(schema.sessions).values({ siteId, visitorHash, dayKey, firstSeen }).onConflictDoNothing()`.
  No raw SQL strings — Drizzle builds parameterized statements.
- **Completion:** `queries.test.ts` (workers pool) inserts an event with non-null `props` and reads
  it back with `props` round-tripping through `JSON.parse`; a returned `id` is a valid UUID; inserting
  the same session `(siteId, visitorHash, dayKey)` twice leaves exactly one `sessions` row.

### T013 — Rate-limit middleware ‖ parallel
- **Files:** `apps/server/src/lib/ratelimit.ts` (new), `apps/server/test/ratelimit.test.ts` (new).
- **Pre-decided details:** `rateLimit(keyFn: (c) => string)` returns Hono middleware:
  `const rl = c.env.RATE_LIMITER; if (!rl) return next();` else `const { success } = await rl.limit({ key: keyFn(c) }); if (!success) throw new ApiError('rate_limited', 429); return next();`
  and on the `rate_limited` error path set `Retry-After: 60` (handle in `onError` when `err.code === 'rate_limited'`, or set the header in the middleware before throwing). For `/api/collect`, `keyFn = (c) => clientIp(c.req.raw)`.
- **Completion:** `ratelimit.test.ts` builds a stub `env.RATE_LIMITER` whose `limit` returns
  `{ success: false }` on the 101st call for a key and `{ success: true }` otherwise; asserts the
  101st request from one key yields 429 with `Retry-After: 60` while a request from a different key
  passes; asserts that with `env.RATE_LIMITER` undefined the middleware calls `next()`.

### T014 — `POST /api/collect` handler (depends T007, T008, T009, T010, T011, T012, T013)
- **Files:** `apps/server/src/routes/collect.ts`, `apps/server/test/collect.test.ts` (new).
- **Pre-decided details:** `collectRoute.post('/', rateLimit(...), vValidator('json', CollectPayloadSchema), handler)`.
  Handler flow, using `now = Date.now()`: read `ua = c.req.header('user-agent') ?? ''`; if
  `isBot(ua)` return `c.body(null, 202)` **without inserting**; else `ip = clientIp(c.req.raw)`,
  `dk = dayKey(now)`, `salt = await getDailySalt(env, dk, now)`, `vh = await visitorHash(ip, ua, salt, body.site_id)`;
  derive `country(c.req.raw)`, `device(ua)`, `name = body.name ?? null`, `props = body.props ?? null`;
  `await insertEvent(env, { siteId: body.site_id, hostname: body.hostname, path: body.path, referrer: body.referrer, name, props, visitorHash: vh, country, device, createdAt: now })`;
  `await upsertSession(env, body.site_id, vh, dk, now)`; return `c.body(null, 202)`. Malformed JSON or
  schema failure → 400 `validation_failed` (validator). Never log `ip`.
- **Completion:** `collect.test.ts` (workers pool): a valid payload → 202 empty body and exactly one
  `events` row with matching `site_id`/`path`, a 64-hex `visitor_hash`, and a `sessions` row; a
  `Googlebot` UA → 202 and **zero** new `events` rows; a malformed body → 400
  `{ error: 'validation_failed' }`; two identical valid payloads within the same UTC day produce two
  `events` rows but one `sessions` row.

### T015 — Browser client `track()` core + shared transport/config ‖ parallel (after T001, T002)
- **Files:** `packages/client/src/index.ts`, `packages/client/src/transport.ts` (new, canonical — see
  DRY mandate), `packages/client/src/config.ts` (new, canonical),
  `packages/client/test/track.test.ts` (new), `packages/client/test/transport.test.ts` (new).
- **Pre-decided details:** `transport.ts` exports `send(host: string, path: string, payload: unknown): void`
  — `navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }))` when available, else
  `fetch(url, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: json })`.
  It is the **only** network path in the client; perf (T063) and experiments (T071) reuse it.
  `config.ts` exports the module-scoped `{ host, siteId }` store + `getConfig()`. `init(config)` sets
  config; `track(name?, props?)` builds a `CollectPayload` from `location`/`document` and calls
  `send(host, '/api/collect', payload)`; no-op if unconfigured. Types from `@countless/shared` are
  type-only (erased). Zero runtime dependencies.
- **Completion:** `track.test.ts` (stubbed `navigator`/`location`/`document`) asserts
  `track('signup', { plan: 'pro' })` calls `sendBeacon` with a body JSON containing
  `site_id`, `name: 'signup'`, `props.plan === 'pro'`, and the current `hostname`/`path`; when
  `navigator.sendBeacon` is undefined it falls back to `fetch` with `keepalive: true`; calling
  `track()` before `init()` does nothing.

### T016 — Auto-init + umami shim ‖ parallel (after T015)
- **Files:** `packages/client/src/auto.ts`, `packages/client/test/auto.test.ts` (new).
- **Pre-decided details:** On load, read the executing `<script>`'s `data-site-id` (required) and
  `data-host` (default = the script `src` origin). Call `init({ siteId, host })`, fire one initial
  `track()` pageview, patch `history.pushState`/`replaceState`, and listen for `popstate` to auto-track
  SPA navigations. Expose `window.umami = { track }` (umami-compatible) and
  `window.countless = { track, init }`. Keep the `declare global` block already in `auto.ts`.
- **Completion:** `auto.test.ts` (mock script tag + history) asserts: after import,
  `typeof window.umami.track === 'function'`; an initial pageview beacon fired once; a simulated
  `history.pushState` fires exactly one additional pageview.

### T017 — Client build (ESM + IIFE) + size budget ‖ parallel (after T015, T016)
- **Files:** `packages/client/tsup.config.ts` (new), `packages/client/package.json`,
  `packages/client/test/size.test.ts` (new).
- **Pre-decided details:** `tsup.config.ts` defines two outputs: (1) ESM library — entries
  `src/index.ts` + `src/auto.ts`, `format: ['esm']`, `dts: true` (the npm consumers' imports and the
  `sideEffects: ['./dist/auto.js']` path); (2) standalone tag bundle — entry `src/auto.ts`,
  `format: ['iife']`, `minify: true`, output filename `script.js` (loaded via
  `<script src="…/script.js" data-site-id="…">`). Update `package.json` `build` to invoke this config
  (`tsup`). Size budget: gzipped `dist/script.js` **≤ 2048 bytes**.
- **Completion:** `pnpm --filter countless build` emits `dist/index.js`, `dist/index.d.ts`,
  `dist/auto.js`, and `dist/script.js`; `size.test.ts` reads `dist/script.js`, gzips it, and asserts
  the byte length ≤ 2048 (skips with an explicit `console`-free message via `test.skipIf` when the
  artifact is absent, so unit runs without a prior build still pass).

---

## Wave 2 — Stats API, authentication, sites & keys

### T018 — API key issuance + hashing ‖ parallel (after T003, T006)
- **Files:** `apps/server/src/lib/apikeys.ts` (new), `apps/server/test/apikeys.test.ts` (new).
- **Pre-decided details:** `generateKey(): string` = `API_KEY_PREFIX + hex(getRandomValues(API_KEY_BYTES))`.
  `hashKey(key: string): Promise<string>` = SHA-256 lowercase hex. `issueKey(env, siteId: string, label: string | null): Promise<{ id: string; key: string }>`:
  generate key, `id = crypto.randomUUID()`, insert `{ id, siteId, keyHash: await hashKey(key), label, createdAt: now, lastUsed: null }`
  (`now` param), return the **plaintext key once** (never retrievable again).
  `listKeys(env, siteId: string): Promise<ApiKeyRecord[]>` (selects id/site_id/label/created_at/last_used only — never `key_hash`).
  `revokeKey(env, id: string, siteId: string): Promise<boolean>` (deletes where `id AND site_id`
  match; returns whether a row was deleted).
- **Completion:** `apikeys.test.ts` asserts an issued key starts with `clk_` and is 68 chars; the DB
  row stores a 64-hex `key_hash` that is **not** the plaintext; `listKeys` returns the record without
  any hash/plaintext field; `revokeKey` deletes it and returns `true`, then `false` on a second call;
  two issuances yield distinct keys and hashes.

### T019 — Auth middleware (API key + admin) ‖ parallel (after T018)
- **Files:** `apps/server/src/lib/auth.ts`, `apps/server/test/auth.test.ts` (new).
- **Pre-decided details:** `authenticateKey(env, authorization: string | null): Promise<string | null>`:
  parse `Bearer <key>` (return `null` if header missing/malformed); `hashKey`; `SELECT site_id FROM api_keys WHERE key_hash=?`;
  on hit, best-effort `UPDATE api_keys SET last_used=? WHERE key_hash=?` and return `site_id`; else
  `null`. Middleware `requireApiKey`: resolves the key, sets `c.set('siteId', siteId)` or throws
  `new ApiError('invalid_api_key', 401)`. Middleware `requireAdmin`: parse `Bearer <token>`, compare
  to `env.ADMIN_TOKEN` in constant time by digesting both with SHA-256 and comparing the equal-length
  hex strings; throw `new ApiError('invalid_admin_token', 401)` on mismatch or missing header.
- **Completion:** `auth.test.ts` asserts a valid key resolves to its `site_id` and bumps `last_used`
  (non-null after the call); a bogus key → `requireApiKey` 401 `invalid_api_key`; `requireAdmin`
  accepts `'test-admin-token'` and rejects any other token and a missing header with 401
  `invalid_admin_token`.

### T020 — Sites & keys admin endpoints + reusable CRUD factory (depends T007, T018, T019)
- **Files:** `apps/server/src/routes/admin.ts` (new), `apps/server/src/lib/crud.ts` (new, canonical
  — see DRY mandate), `apps/server/src/routes/registry.ts` (append entry),
  `apps/server/test/admin.test.ts` (new), `apps/server/test/crud.test.ts` (new).
- **Pre-decided details:** `crud.ts` exports `crudRouter({ table, schema, resourceKey })` producing a
  Hono router with the canonical admin pattern (`POST` insert-with-uuid → `201 { [resourceKey]: row }`,
  `GET ?site_id=` → `200 { [resourceKey+'s']: row[] }`, `DELETE /:id?site_id=` → `200 { deleted }` /
  404), all under `requireAdmin`. Sites/keys reuse it where they fit; goals/funnels/experiments/
  sources (later phases) are built **only** via `crudRouter` — no re-implemented CRUD blocks. Mount by
  appending to `registry.ts` (not `app.ts`). Every admin router is guarded by `requireAdmin`:
  - `POST /api/sites` (`vValidator('json', CreateSiteSchema)`) → insert `{ id: crypto.randomUUID(), name, domain, created_at: now }`; `201 { site: Site }`.
  - `GET /api/sites` → `200 { sites: Site[] }` (ordered by `created_at` desc).
  - `POST /api/keys` (`vValidator('json', IssueKeySchema)`) → `issueKey`; `201 { id, key }` (plaintext once).
  - `GET /api/keys?site_id=<uuid>` → `200 { keys: ApiKeyRecord[] }` (no hash, no plaintext).
  - `DELETE /api/keys/:id?site_id=<uuid>` → `revokeKey`; `200 { deleted: true }` or `404 { error: 'not_found' }`.
- **Completion:** `admin.test.ts` (with `ADMIN_TOKEN='test-admin-token'`): create site → 201 with a
  UUID `id`; list → contains it; issue key → 201 `{ id, key }` where `key` starts with `clk_`; list
  keys → the record without a hash; delete key → 200 `{ deleted: true }`, second delete → 404;
  missing/wrong admin token on any route → 401 `invalid_admin_token`.

### T021 — Stats query helpers + shared WHERE-builder (depends T006, T012)
- **Files:** `apps/server/src/db/stats.ts` (new), `apps/server/src/db/filters.ts` (new, canonical —
  see DRY mandate), `apps/server/test/stats-queries.test.ts` (new),
  `apps/server/test/filters.test.ts` (new).
- **Pre-decided details:** Define `interface StatsFilter { siteId: string; hostname?: string; start: number; end: number }`
  in `@countless/shared`. `filters.ts` exports `buildEventWhere(f)` (the single builder for the
  site/hostname/time predicate over `events`, extended in T082 with path/country/device/channel) so
  no helper hand-writes its own `WHERE`. All helpers read the indexed `events` table via Drizzle
  (`sql` helpers for `COUNT(DISTINCT …)` and bucket math — no raw string SQL) and compose
  `buildEventWhere(f)`:
  - `summary(env, f): Promise<StatsSummary>` → `pageviews = COUNT(*) WHERE name IS NULL`,
    `events = COUNT(*) WHERE name IS NOT NULL`, `visitors = COUNT(DISTINCT visitor_hash)`.
  - `series(env, f, interval): Promise<SeriesPoint[]>` → group by `bucket = created_at - (created_at % bucketMs)`
    (`bucketMs = HOUR_MS` for `'hour'`, `DAY_MS` for `'day'`), each point `{ t: bucket, pageviews, visitors }`;
    return ascending and **zero-fill** every empty bucket across `[start, end)`.
  - `topPaths(env, f, limit = 10)`, `topReferrers(env, f, limit = 10)` (exclude `referrer = ''`),
    `topEvents(env, f, limit = 10)` (`WHERE name IS NOT NULL GROUP BY name`),
    `topCountries(env, f, limit = 10)` (exclude NULL country), `topDevices(env, f)` (group by device,
    exclude NULL) → each `Promise<CountRow[]>` sorted by count desc.
- **Completion:** `stats-queries.test.ts` seeds a fixed set (~20 events across two hostnames, three
  paths, two devices, two countries, one custom event, spanning three hours) and asserts each helper
  returns the arithmetically exact numbers, that the `hostname` filter changes the results, and that
  `series` zero-fills gap buckets.

### T022 — `GET /api/stats` handler (depends T019, T021)
- **Files:** `apps/server/src/routes/stats.ts`, `apps/server/test/stats.test.ts` (new).
- **Pre-decided details:** `statsRoutes.get('/stats', requireApiKey, vValidator('query', StatsQuerySchema), handler)`.
  Handler: if `query.site_id !== c.get('siteId')` throw `new ApiError('site_mismatch', 403)`; if
  `query.end <= query.start` throw `new ApiError('bad_range', 400)`; if
  `query.end - query.start > MAX_RANGE_DAYS * DAY_MS` throw `new ApiError('range_too_large', 400)`;
  `interval = query.interval ?? (query.end - query.start <= 48 * HOUR_MS ? 'hour' : 'day')`; assemble
  `StatsResponse` (`summary`, `series`, `top_paths`, `top_referrers`, `top_events`, `top_countries`,
  `top_devices`) from the T021 helpers with `f = { siteId: query.site_id, hostname: query.hostname, start: query.start, end: query.end }`;
  `200` JSON.
- **Completion:** `stats.test.ts` (workers pool): seed a site + key + events, GET `/api/stats` with
  the key returns the correct `summary`, a non-empty `series`, and populated top lists including
  `top_countries`/`top_devices`; a key scoped to a different site → 403 `site_mismatch`; missing auth
  → 401 `invalid_api_key`; `end <= start` → 400 `bad_range`; a range over 90 days → 400
  `range_too_large`.

---

## Wave 3 — Dashboard

### T023 — Dashboard tooling: Tailwind v4 + Query client + test env (depends T001)
- **Files:** `apps/dashboard/vite.config.ts`, `apps/dashboard/src/index.css` (new),
  `apps/dashboard/src/main.tsx`, `apps/dashboard/src/lib/cn.ts` (new),
  `apps/dashboard/vitest.config.ts` (new), `apps/dashboard/src/test/setup.ts` (new),
  `apps/dashboard/src/test/App.test.tsx` (new).
- **Pre-decided details:** Add `@tailwindcss/vite` to `vite.config.ts` plugins; `index.css` =
  `@import 'tailwindcss';`, imported from `main.tsx`. Wrap `<App/>` in `QueryClientProvider` with a
  module `queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } } })`.
  `lib/cn.ts` exports `cn(...inputs) = twMerge(clsx(inputs))`. `vitest.config.ts`:
  `environment: 'jsdom'`, `setupFiles: ['./src/test/setup.ts']`; setup imports
  `@testing-library/jest-dom`.
- **Completion:** `pnpm --filter @countless/dashboard build` succeeds; `App.test.tsx` renders `<App/>`
  under jsdom and asserts the `Countless` heading is present.

### T024 — Dashboard API client + hooks foundation (depends T022, T023)
- **Files:** `apps/dashboard/src/api.ts`, `apps/dashboard/src/hooks/stats.ts` (new),
  `apps/dashboard/src/hooks/index.ts` (new, barrel), `apps/dashboard/src/test/api.test.ts` (new).
- **Pre-decided details:** `api.ts` exports the **canonical** `apiFetch<T>(path: string, apiKey: string): Promise<T>`
  — GET `path` with `Authorization: Bearer ${apiKey}`, base URL `''` (same origin); on non-200 throw
  `new Error(body.error ?? 'request_failed')`. **Every feature fetcher uses `apiFetch`**; no component
  calls `fetch` directly. `hooks/` is a folder of per-feature files (not one `hooks.ts`) with a barrel
  `hooks/index.ts`, so parallel dashboard tasks never collide; `hooks/stats.ts` exports
  `useStats(apiKey, query) = useQuery({ queryKey: ['stats', query], queryFn: () => apiFetch('/api/stats?'+qs(query), apiKey), enabled: Boolean(apiKey) })`.
  `site_id` is stored with the key (T025) and passed into every query; no `fetchSites` for key holders.
- **Completion:** `api.test.ts` mocks `fetch`; asserts `fetchStats` sends the bearer header and
  returns parsed data; a 401 response surfaces as a thrown error whose message is the response
  `error` code.

### T025 — Layout, key gate, site + date-range controls (depends T023)
- **Files:** `apps/dashboard/src/App.tsx`, `apps/dashboard/src/components/Layout.tsx` (new),
  `apps/dashboard/src/components/DateRange.tsx` (new), `apps/dashboard/src/components/KeyGate.tsx` (new),
  `apps/dashboard/src/state.ts` (new), `apps/dashboard/src/test/keygate.test.tsx` (new).
- **Pre-decided details:** `KeyGate` prompts for API key + `site_id`, persists to
  `localStorage['countless.key']` and `localStorage['countless.site']`; the app renders `KeyGate`
  until both are present. `DateRange` presets `24h`, `7d`, `30d`, `90d` (default `7d`) computed with
  `date-fns` `subDays`, producing `{ start, end }` ms (with `end = Date.now()`). Selected preset lives
  in URL `?range=7d` and app state (`state.ts`, `useState` + context). Tailwind + `cn` for styling.
- **Completion:** `keygate.test.tsx` asserts: with no stored key, `KeyGate` renders; entering key +
  site persists both to `localStorage` and renders the dashboard shell; switching the range preset
  updates the derived `{ start, end }` and the query key.

### T026 — KPI cards + time-series chart (depends T024, T025)
- **Files:** `apps/dashboard/src/components/KpiCards.tsx` (new),
  `apps/dashboard/src/components/TrafficChart.tsx` (new), `apps/dashboard/src/test/charts.test.tsx` (new).
- **Pre-decided details:** `KpiCards` shows Pageviews, Unique Visitors, Custom Events from `summary`,
  formatted via `Intl.NumberFormat`. `TrafficChart` = a thin React wrapper around **uPlot**
  (`import 'uplot/dist/uPlot.min.css'`): mount uPlot into a `useRef` container, feed two series
  (pageviews, visitors) from `series` (x = bucket seconds), resize via `ResizeObserver`, destroy on
  unmount; axis/tooltip timestamps via `date-fns format`. States: loading → skeleton; error → inline
  message; empty series → "No data yet".
- **Completion:** `charts.test.tsx` with mocked `useStats` data asserts the three KPI numbers render
  (formatted) and `TrafficChart` mounts a `.uplot` node with two series.

### T027 — Top lists + geo/device breakdowns (depends T024, T025)
- **Files:** `apps/dashboard/src/components/TopList.tsx` (new),
  `apps/dashboard/src/components/Breakdowns.tsx` (new), `apps/dashboard/src/test/toplist.test.tsx` (new).
- **Pre-decided details:** `TopList` renders a `CountRow[]` as Plausible-style horizontal bars (bar
  width = `count / max`, pure CSS/Tailwind, no chart lib); empty list → empty state. `Breakdowns`
  renders panels: Top Pages (`top_paths`), Top Referrers (`top_referrers`), Custom Events
  (`top_events`), Top Countries (`top_countries`), Devices (`top_devices`) — all as `TopList`s. v1 geo
  is a ranked country list, **not** a map.
- **Completion:** `toplist.test.tsx` asserts `TopList` renders one row per `CountRow` with a bar width
  proportional to the max value; an empty list renders the empty state.

### T028 — Serve dashboard from the Worker (depends T007, T026, T027)
- **Files:** `apps/server/src/app.ts`, `apps/server/test/spa.test.ts` (new).
- **Pre-decided details:** `assets.directory = ../dashboard/dist` and `binding: ASSETS` are already
  in `wrangler.jsonc` (do **not** re-edit wrangler). In `app.ts`, add a fallthrough: any non-`/api/*`
  request is served by `env.ASSETS.fetch(c.req.raw)`; if that returns 404 for a navigation request,
  serve `/index.html` (SPA fallback, 200). Never route `/api/*` to assets. The dashboard is built
  before server tests by the existing `apps/server` `pretest` script
  (`pnpm --filter @countless/dashboard build`).
- **Completion:** `spa.test.ts` asserts `GET /` and `GET /some/spa/route` return the dashboard HTML
  (`text/html`, containing `<div id="root">`) while `GET /api/health` still returns JSON.

---

## Wave 4 — Rollups, cron, retention, observability

### T029 — Rollup aggregation ‖ parallel (after T006, T021)
- **Files:** `apps/server/src/lib/rollups.ts`, `apps/server/test/rollups.test.ts` (new).
- **Pre-decided details:** `rollupBucket(env, interval: Interval, bucketStart: number, bucketEnd: number): Promise<void>`:
  for each `(site_id, hostname)` with events in `[bucketStart, bucketEnd)`, compute `pageviews`
  (`name IS NULL`), `events` (`name IS NOT NULL`), `visitors` (`COUNT(DISTINCT visitor_hash)`) and
  upsert into `event_rollups` on its PK (`onConflictDoUpdate`, i.e. INSERT-OR-REPLACE semantics).
  `runRollups(env, now: number): Promise<void>`: roll up the most recently **completed** hour
  (`interval='hour'`, `bucketStart = floor(now/HOUR_MS)*HOUR_MS - HOUR_MS`); when `now` is within the
  first hour of a UTC day, also roll up the completed day (`interval='day'`, previous `DAY_MS`
  bucket). Idempotent.
- **Salt boundary is a non-issue by construction (do not add lookback logic):** rotation happens at
  exactly UTC 00:00, which is simultaneously an hour boundary and a day boundary. Every hour bucket
  (`floor(t/HOUR_MS)*HOUR_MS`) and every day bucket therefore lies entirely within a single UTC day
  and a single salt. No bucket ever straddles two salts, so `COUNT(DISTINCT visitor_hash)` within a
  bucket is always computed under one consistent salt. **Never** implement a "check the previous
  day's salt / recompute yesterday's hash" lookback — it is impossible here (raw IP/UA are not
  stored, so nothing can be re-hashed) and would require persisting PII, violating the privacy model.
  Cross-day visitor identity is intentionally unavailable.
- **Completion:** `rollups.test.ts` seeds events in a known hour across two hostnames, runs
  `runRollups`, and asserts one `event_rollups` row per hostname with correct counts; a second run
  produces identical rows (no duplication, no drift).

### T030 — Retention cleanup ‖ parallel (after T006)
- **Files:** `apps/server/src/lib/retention.ts` (new), `apps/server/test/retention.test.ts` (new).
- **Pre-decided details:** `enforceRetention(env, now: number): Promise<void>`:
  `days = Number.parseInt(env.RAW_RETENTION_DAYS, 10); if (!Number.isFinite(days)) days = DEFAULT_RETENTION_DAYS;`
  `cutoff = now - days * DAY_MS;` then `DELETE FROM events WHERE created_at < cutoff`,
  `DELETE FROM sessions WHERE first_seen < cutoff`, `DELETE FROM salts WHERE created_at < cutoff`.
  `event_rollups` are **never** deleted (durable history).
- **Completion:** `retention.test.ts` inserts events/sessions/salts older and newer than the cutoff,
  runs `enforceRetention`, and asserts only stale rows are deleted and any `event_rollups` rows
  remain untouched.

### T031 — Structured logging / observability ‖ parallel (after T004)
- **Files:** `apps/server/src/lib/log.ts` (new), `apps/server/test/log.test.ts` (new),
  `apps/server/src/app.ts`.
- **Pre-decided details:** `createLogger(base?: Record<string, string | number>)` returns
  `{ info(msg, fields?), warn(msg, fields?), error(msg, err?, fields?) }`, each emitting a single JSON
  line via `console.log`/`console.error` with `{ level, msg, ...base, ...fields }` (captured by the
  Workers `observability` already enabled in `wrangler.jsonc`). **PII guard:** the `fields` type
  forbids a key named `ip`, and the logger strips any `ip`/`CF-Connecting-IP` field at runtime. Wire
  `app.onError` to log `error` at 500 (never logging request bodies or IPs). This logger is the only
  sanctioned console output (exempt from the DoD "no console.log" rule).
- **Completion:** `log.test.ts` spies on `console.log`/`console.error` and asserts a single JSON line
  with the expected shape is emitted; asserts that passing a field object containing `ip` results in
  no `ip` appearing in the output.

### T032 — Scheduled job registry + handler wiring (depends T029, T030, T031)
- **Files:** `apps/server/src/lib/scheduled.ts` (new, canonical — see DRY mandate),
  `apps/server/src/index.ts`, `apps/server/test/scheduled.test.ts` (new).
- **Pre-decided details:** `scheduled.ts` exports `interface ScheduledJob { name: string; run(env, now): Promise<void> }`,
  a `JOBS: ScheduledJob[]` array (initially rollups + retention), `registerJob(job)`, and
  `runScheduled(event, env)` which iterates `JOBS` running each with its own try/catch that logs via
  the T031 logger (one job's failure never skips another). **Later cron work (sessions T048, insights
  T088b, social poll T093b) registers a job here instead of editing `runScheduled`.** `index.ts`
  invokes `runScheduled` from `scheduled` via `ctx.waitUntil`.
- **Completion:** `scheduled.test.ts` seeds events (some older than retention, some in the last
  completed hour), invokes `runScheduled` directly, and asserts rollups were written **and** stale raw
  rows purged in the single pass; a thrown error in the rollup step still runs retention (assert via
  an injected failing stub).

---

## Wave 5 — CLI

### T033 — CLI arg parsing + dispatch ‖ parallel (after T001)
- **Files:** `packages/cli/src/index.ts`, `packages/cli/src/util.ts` (new),
  `packages/cli/test/cli.test.ts` (new).
- **Pre-decided details:** Keep the `main(argv)` dispatcher over `init | migrate | stats`. Add global
  `--help`/`-h` → print usage to stdout, return 0; unknown command → print usage to stderr, return 1.
  Refactor `main` to be exported and pure (no `process.exit` inside); the `#!/usr/bin/env node`
  bootstrap at the bottom calls `main(process.argv.slice(2)).then((c) => process.exit(c))`. `util.ts`
  exports `printError(msg)` (picocolors red to stderr) and `fetchJson<T>(url, init?): Promise<T>` over
  native `fetch` (throws on non-2xx with the response `error` code).
- **Completion:** `cli.test.ts` asserts `main(['--help'])` returns 0 and prints usage;
  `main(['bogus'])` returns 1; `main([])` returns 0 and prints usage.

### T034 — `countless init` ‖ parallel (after T033)
- **Files:** `packages/cli/src/commands/init.ts`, `packages/cli/test/init.test.ts` (new).
- **Pre-decided details:** `runInit(args)` parses `--name <worker>`, `--db <dbName>` (default
  `countless`), `--dir <path>` (default `.`), `--dry-run`. Using `@clack/prompts` for any missing
  required value (skipped under `--dry-run`), write `wrangler.jsonc` (from a bundled template
  mirroring `apps/server/wrangler.jsonc`, with the given names substituted) and `.dev.vars` containing
  `ADMIN_TOKEN=<hex(32)>` into `--dir`. Print the `wrangler d1 create <dbName>` command to run next.
  Never make network/`wrangler` calls in tests.
- **Completion:** `init.test.ts` runs `runInit(['--dry-run','--name','demo','--db','countless','--dir',<tmp>])`
  and asserts a `wrangler.jsonc` (containing `"name": "demo"` and the db name) and a `.dev.vars`
  (containing `ADMIN_TOKEN=`) are written into the temp dir.

### T035 — `countless migrate` ‖ parallel (after T033)
- **Files:** `packages/cli/src/commands/migrate.ts`, `packages/cli/test/migrate.test.ts` (new).
- **Pre-decided details:** `runMigrate(args, spawnImpl = spawn)` parses `--db <name>` (default
  `countless`) and `--remote`. Build argv `['d1','migrations','apply', dbName, remote ? '--remote' : '--local']`
  and `spawnImpl('wrangler', argv, { stdio: 'inherit' })`; resolve to the child exit code. The
  spawner is injectable for tests.
- **Completion:** `migrate.test.ts` injects a fake spawner and asserts
  `runMigrate(['--db','countless','--remote'], fake)` builds
  `wrangler d1 migrations apply countless --remote`; the default (no `--remote`) ends with `--local`.

### T036 — `countless stats` ‖ parallel (after T033)
- **Files:** `packages/cli/src/commands/stats.ts`, `packages/cli/test/stats.test.ts` (new).
- **Pre-decided details:** `runStats(args, fetchImpl = fetchJson)` parses `--host <url>`,
  `--key <apiKey>`, `--site <uuid>`, `--range <24h|7d|30d|90d>` (default `7d`). Compute `{ start, end }`
  from the range, GET `${host}/api/stats?...` with `Authorization: Bearer <key>` via the injected
  `fetchImpl`, print a picocolors summary table (pageviews / visitors / events + top 5 paths). Non-2xx
  → `printError` + return 1.
- **Completion:** `stats.test.ts` injects a `fetchJson` returning a fixed `StatsResponse` and asserts
  the printed output contains the pageviews/visitors/events totals and the top-5 paths; an injected
  throwing `fetchJson` → return 1.

---

## Wave 6 — Seed, security review, docs, release, acceptance

### T037 — Local-dev seed data ‖ parallel (after T003)
- **Files:** `apps/server/scripts/seed.sql` (new), `apps/server/package.json` (script),
  `docs/self-hosting.md` (seed section — created in T039, cross-referenced here).
- **Pre-decided details:** `seed.sql` inserts, with fixed literals (no randomness): one site
  (`id = '11111111-1111-4111-8111-111111111111'`, name `Demo`, domain `demo.local`); one `api_keys`
  row whose `key_hash` = the SHA-256 hex of the documented plaintext dev key `clk_localdevkey`
  (compute the digest once and inline the literal hash); and 30 `events` across two hostnames
  (`demo.local`, `blog.demo.local`), three paths (`/`, `/pricing`, `/blog`), two devices, two
  countries, and one custom event `signup`, with `created_at` values spread across the preceding seven
  days relative to a fixed base epoch written into the file as a literal. Add
  `"seed:local": "wrangler d1 execute countless --local --file=./scripts/seed.sql"` to
  `apps/server/package.json`.
- **Completion:** after `pnpm --filter @countless/server migrate:local` then `seed:local`,
  `wrangler d1 execute countless --local --command "SELECT count(*) FROM events"` returns 30 and
  `SELECT count(*) FROM sites` returns 1; the dev key `clk_localdevkey` authenticates against a local
  `wrangler dev` (documented, not asserted in CI).

### T038 — Privacy & security review of the hashing design (depends T014, T032)
- **Files:** `apps/server/test/privacy.test.ts` (new), `docs/privacy.md` (updated in T039).
- **Pre-decided details:** A verification-only task (no new product code) that pins the privacy
  guarantees as tests: (1) after ingesting an event, no column of any `events`/`sessions` row equals
  or contains the raw `CF-Connecting-IP` used (assert the ip string appears in no stored field);
  (2) the same `(ip, ua, site)` on two different `dayKey`s produces two different `visitor_hash`es
  (daily un-linkability); (3) `visitorHash` output length/charset is exactly 64 lowercase hex;
  (4) a static assertion that the source of `apps/server/src/lib/hash.ts` and `.../salt.ts` contains
  no `console` call referencing `ip` (simple source scan). If any assertion fails, the design/impl is
  wrong and must be fixed before proceeding.
- **Completion:** `privacy.test.ts` passes all four assertions.

### T039 — Docs ‖ parallel (after T014, T020, T022, T032)
- **Files:** `docs/usage.md`, `docs/self-hosting.md`, `docs/privacy.md`, `docs/api.md`,
  `docs/README.md`.
- **Pre-decided details:** `usage.md`: `<script src=".../script.js" data-site-id="…">` tag + npm
  `import { init, track } from 'countless'` examples; umami-migration note
  (`window.umami.track` compatibility). `self-hosting.md`: prerequisites (Node ≥ 20, pnpm 11,
  Cloudflare account); `wrangler d1 create countless`; put the real `database_id` into
  `wrangler.jsonc`; `wrangler secret put ADMIN_TOKEN`; `pnpm --filter @countless/server migrate:remote`;
  build dashboard; `pnpm --filter @countless/server deploy`; curl examples to create a site + issue a
  key via the admin endpoints; the T037 seed instructions. `privacy.md`: the exact hash formula
  (`SHA-256(ip ⧊ ua ⧊ salt ⧊ site)`), salt rotation, the daily-uniques semantics, retention, and
  "no raw IP stored". `api.md`: full request/response for `/api/collect`, `/api/stats`, `/api/sites`,
  `/api/keys` (incl. `DELETE`), with auth headers, status codes, and the canonical error-body table.
  Remove every "stub"/"TBD" marker across all docs.
- **Completion:** no doc contains the strings "stub" or "TBD"; `api.md` documents every implemented
  endpoint with an example request and an example response body matching the shipped shapes; a grep
  for `countless_db`, `--filter web`, or `--filter worker` across `docs/` returns nothing.

### T040 — README + Deploy to Cloudflare button (depends T028, T039)
- **Files:** `README.md`.
- **Pre-decided details:** Keep a documented `OWNER/countless` placeholder for the GitHub slug in the
  deploy-button URL. Ensure the packages table, quick-start, and privacy summary match shipped
  behavior; add a "Create a site & API key" snippet (curl against the admin endpoints).
- **Completion:** every relative link in `README.md` resolves to an existing file; the deploy button
  href is exactly `https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/countless`.

### T041 — CHANGELOG + version alignment (depends T039)
- **Files:** `CHANGELOG.md` (new), root `package.json`, `packages/client/package.json`,
  `packages/cli/package.json`.
- **Pre-decided details:** Create `CHANGELOG.md` (Keep-a-Changelog format) with an
  `## [0.1.0]` section summarizing v1. Set `version` to `0.1.0` in the root, `countless`, and
  `countless-cli` `package.json` files (keep `@countless/server`/`@countless/dashboard` private and at
  `0.0.0`). Do not publish anything here — that is T042.
- **Completion:** `CHANGELOG.md` has a `0.1.0` entry; `countless` and `countless-cli` both report
  `0.1.0`; `pnpm -r typecheck` = 0.

### T042 — CI + npm release workflow (depends T005, and all code tasks T001–T037)
- **Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml` (new).
- **Pre-decided details:** `ci.yml` already runs install/lint/typecheck/test — add a `build` step
  (`pnpm build`) after typecheck so dashboard + client artifacts compile (and the server `pretest`
  asset dir exists). `release.yml`: trigger on tag `v*`; **first step is an environment-readiness
  gate** — a `check-credentials` step that fails fast with a clear message if `secrets.NPM_TOKEN` is
  empty (`if [ -z "$NPM_TOKEN" ]; then echo "NPM_TOKEN missing"; exit 1; fi`) **before** any build
  runs, so a mis-provisioned release never publishes a half-built artifact. Then install, build, then
  `pnpm publish --filter countless --filter countless-cli --access public --no-git-checks` with
  `provenance: true`, authenticating via the `NPM_TOKEN` secret (`NODE_AUTH_TOKEN`). Set
  `permissions: { contents: read, id-token: write }` (required for npm provenance). Never publish the
  private server/dashboard packages.
- **Completion:** `ci.yml` contains lint + typecheck + test + build steps; `release.yml` passes
  `actionlint` (or a manual YAML validation), runs the `check-credentials` gate before `build`, sets
  `id-token: write`, and its publish filter names only `countless` and `countless-cli`.

### T043 — End-to-end acceptance test (depends T014, T022, T028, T032)
- **Files:** `apps/server/test/e2e.test.ts` (new).
- **Pre-decided details:** Full path in one workers-pool test with migrations applied and
  `ADMIN_TOKEN='test-admin-token'`: (1) `POST /api/sites` + `POST /api/keys` (admin) to create a site
  and key; (2) `POST /api/collect` several times using the shared client payload shape — including a
  bot UA (dropped), a pageview and a custom `signup` event, across **two hostnames**; (3) invoke the
  exported `scheduled` handler (drives rollups + retention); (4) `GET /api/stats` with the key and
  assert `summary.pageviews`/`visitors`/`events` and the top lists exactly match the seeded non-bot
  traffic, and that a `hostname`-filtered request returns the **per-hostname split**; (5) `GET /`
  returns dashboard HTML. This test is the release gate for the ingest → D1 → rollup → stats → asset
  path.
- **Completion:** `e2e.test.ts` passes, exercising client-payload → collect → D1 → scheduled rollup →
  stats (with per-hostname split) → asset serving, with exact asserted aggregate values.

---

# v2+ Roadmap (Phases 2–9)

v1 (T001–T043) ships as-is and is never blocked by anything below. Each phase is additive: new
migrations (numbered `000N`), new tables/bindings, new endpoints/components, and its own
unit + Worker-integration + end-to-end acceptance tasks. All Global Conventions (ESM, Biome tab-4,
DoD, error-code table, per-test D1 isolation, structured logging) apply unchanged. The
**closed-schema rule still holds**: a migration task **is** the sanctioned design pass for the
columns it introduces, and it must list every new column exactly; nothing beyond a migration's
declared columns may be added.

### Phase 2+ pinned dependencies, bindings & constants (fixed)

| Concern | Choice | Version | Introduced in |
| --- | --- | --- | --- |
| Web Vitals capture | `web-vitals` | 4.2.4 | Phase 4 (bundled into a separate `perf.js`; core client stays zero-dep) |
| Advanced dashboard charts | `echarts` | 5.5.1 | Phase 7 (canvas; funnel/sankey/heatmap/stacked; uPlot retained for the main time-series) |
| Dashboard routing | `react-router-dom` | 6.28.0 | Phase 7 |
| RSS/Atom parsing | `fast-xml-parser` | 4.5.0 | Phase 9 (Worker has no XML DOMParser) |
| High-cardinality metrics store | **Workers Analytics Engine** (`AE`) | native | Phase 4 |
| Live fan-out | **Durable Objects** (`LIVE`, hibernatable WebSockets) | native | Phase 6 |
| Async pipelines | **Queues** (`SOCIAL_QUEUE`) | native | Phase 9 |
| Sentiment / text / embeddings | **Workers AI** (`AI`) | native | Phases 8–9 |
| Vector clustering | **Vectorize** (`MENTIONS_INDEX`) | native | Phase 9 |
| Raw payload archive | **R2** (`RAW`) | native | Phase 9 |

**New Cloudflare bindings** are added to `apps/server/wrangler.jsonc` by promoting the commented
blocks: `analytics_engine_datasets` (`AE`, dataset `countless_perf`) — T062a; `durable_objects`
(`LIVE` → class `LiveHub`, migration tag `v2`) — T076; `ai` (`AI`) — T086; `queues`
(`SOCIAL_QUEUE`) + `vectorize` (`MENTIONS_INDEX`, 768-dim, cosine) + `r2_buckets` (`RAW`) — T092.

**New secrets/vars:** `CF_ACCOUNT_ID` (var) + `CF_API_TOKEN` (secret, Analytics-Engine-Read scope)
for AE SQL queries — Phase 4. Social-source connector credentials (Phase 9) are **external** and
flagged per-connector.

**New Workers AI models (pinned model ids):** sentiment `@cf/huggingface/distilbert-sst-2-int8`;
embeddings `@cf/baai/bge-base-en-v1.5` (768-dim); text summaries `@cf/meta/llama-3.1-8b-instruct`.

**New named constants** (server `constants.ts` unless noted): `SESSION_TIMEOUT_MS = 1_800_000`
(30 min); `ANOMALY_Z = 3.0`; `SIGNIFICANCE_ALPHA = 0.05`; `EXPERIMENT_ID_KEY = 'countless.exp'`
(localStorage, client); `LIVE_WINDOW_MS = 1_800_000` (30 min live retention in the DO);
`PERF_METRICS = ['lcp','cls','inp','fcp','ttfb','load','response'] as const`;
`SOCIAL_HOSTS`, `SEARCH_HOSTS`, `PAID_MEDIUMS` (channel-classification sets, Phase 2).

**Channel classification is a privacy-model change** (Phase 2 captures UTM), the persistent
experiment id (Phase 5) and third-party social content (Phase 9) likewise expand data collection —
each gets an explicit security/privacy-review task (T053, T075, T099).

---

## Phase 2 — Sessions, Engagement & Traffic Sources

Derives sessions from existing raw events, adds engagement metrics (bounce rate, pages/session,
avg duration), and classifies traffic sources. Migration `0002`. New endpoints
`GET /api/stats/sessions`, `GET /api/stats/channels`; extended `GET /api/stats`. Dashboard gains an
Engagement panel + Channels breakdown. No new CLI surface.

### T044 — Migration 0002: sessions & traffic schema
- **Description:** Add the session-materialization table and the traffic-source columns.
- **Files:** `apps/server/src/db/schema.ts`, `apps/server/migrations/0002_sessions_traffic.sql`,
  `apps/server/test/schema-0002.test.ts` (new), `apps/server/test/schema.test.ts` (update the
  `events` column-count assertion from T003).
- **Pre-decided details:** Add columns to `events`: `utm_source TEXT`, `utm_medium TEXT`,
  `utm_campaign TEXT`, `channel TEXT` (nullable; `channel` is one of
  `direct|referral|organic|social|paid|email|internal`). New table `event_sessions`:
  `id TEXT PK`, `site_id TEXT NOT NULL`, `visitor_hash TEXT NOT NULL`, `day_key TEXT NOT NULL`,
  `started_at INTEGER NOT NULL`, `ended_at INTEGER NOT NULL`, `entry_path TEXT NOT NULL`,
  `exit_path TEXT NOT NULL`, `channel TEXT`, `pageviews INTEGER NOT NULL DEFAULT 0`,
  `events INTEGER NOT NULL DEFAULT 0`, `duration_ms INTEGER NOT NULL DEFAULT 0`,
  `is_bounce INTEGER NOT NULL DEFAULT 0` (0/1); index
  `idx_sessions_site_started (site_id, started_at)`. Regenerate via `db:generate` (no hand edits).
  This migration is the approved design pass extending the `events` closed schema to **15 columns**;
  update the T003 `PRAGMA table_info(events)` expectation from 11 to 15.
- **Completion:** `db:generate` yields no diff; `schema-0002.test.ts` (T006 harness) asserts
  `PRAGMA table_info(events)` returns 15 columns including `channel`, and `event_sessions` exists
  with the 13 defined columns; the updated `schema.test.ts` passes.

### T045 — Traffic-source classification + UTM parsing lib ‖ parallel
- **Files:** `apps/server/src/lib/channel.ts` (new), `apps/server/test/channel.test.ts` (new),
  `apps/server/src/lib/constants.ts` (add sets).
- **Pre-decided details:** Constants: `PAID_MEDIUMS = new Set(['cpc','ppc','paid','paidsearch','display'])`;
  `SOCIAL_HOSTS` = `{facebook.com, m.facebook.com, twitter.com, x.com, t.co, linkedin.com,
  lnkd.in, instagram.com, youtube.com, reddit.com, pinterest.com, tiktok.com}`; `SEARCH_HOSTS`
  matched by registrable-domain prefix `{google., bing., duckduckgo., yahoo., yandex., baidu.,
  ecosia.}`. `parseUtm(search: string): { source: string | null; medium: string | null; campaign: string | null }`
  reads `utm_source/utm_medium/utm_campaign` from a URL query string. `classifyChannel(args: { referrer: string; utm: { source, medium, campaign }; siteHostname: string }): Channel`
  applies, in order: paid (utm_medium ∈ PAID_MEDIUMS) → email (utm_medium==='email' or
  utm_source==='newsletter') → social (utm_medium==='social' or referrer host ∈ SOCIAL_HOSTS) →
  organic (referrer host matches SEARCH_HOSTS) → direct (empty referrer) → internal (referrer host
  === siteHostname) → referral (otherwise). Pure, no I/O.
- **Completion:** `channel.test.ts` asserts each branch with a fixed table of inputs → exact channel,
  incl. `?utm_medium=cpc` → `paid`, `google.com` referrer → `organic`, empty referrer → `direct`,
  same-host referrer → `internal`.

### T046 — Client UTM capture ‖ parallel (after T015)
- **Files:** `packages/client/src/index.ts`, `packages/client/test/utm.test.ts` (new),
  `packages/shared/src/schemas.ts` (extend `CollectPayloadSchema`).
- **Pre-decided details:** Extend `CollectPayloadSchema` with optional
  `utm: v.optional(v.object({ source: v.optional(v.pipe(v.string(), v.maxLength(200))), medium: v.optional(v.pipe(v.string(), v.maxLength(200))), campaign: v.optional(v.pipe(v.string(), v.maxLength(200))) }))`.
  `track()` reads `location.search`, and when any `utm_*` present includes the `utm` object in the
  payload (omitted entirely when none). Still zero runtime deps.
- **Completion:** `utm.test.ts` asserts that with `location.search='?utm_source=nl&utm_medium=email'`
  the beacon body contains `utm.source==='nl'` and `utm.medium==='email'`; with no utm params, no
  `utm` key is sent; `CollectInput` still assignable to `CollectPayload`.

### T047 — Collect handler: persist utm + channel (after T014, T044, T045, T046)
- **Files:** `apps/server/src/routes/collect.ts`, `apps/server/test/collect-channel.test.ts` (new),
  `apps/server/src/db/queries.ts` (extend `NewEvent`).
- **Pre-decided details:** Extend `NewEvent` with `utmSource/utmMedium/utmCampaign: string | null`
  and `channel: Channel | null`. In the handler compute
  `channel = classifyChannel({ referrer: body.referrer, utm: body.utm ?? {source:null,medium:null,campaign:null}, siteHostname: body.hostname })`
  and pass utm + channel into `insertEvent`. Serialization: `collect.ts` is edited here after T014
  (single-writer sequence).
- **Completion:** `collect-channel.test.ts` posts a payload with `utm_medium=cpc` and asserts the
  stored `events` row has `channel='paid'` and `utm_medium='cpc'`; an empty-referrer payload stores
  `channel='direct'`.

### T048 — Sessionization builder (cron) ‖ parallel (after T044)
- **Files:** `apps/server/src/lib/sessions.ts` (new), `apps/server/test/sessions.test.ts` (new).
- **Pre-decided details:** `buildSessions(env, dayKey: string): Promise<number>` reads all `events`
  for `dayKey` (derive `dayKey` from `created_at`) ordered by `(site_id, visitor_hash, created_at)`;
  groups consecutive events per `(site_id, visitor_hash)` splitting whenever the gap between adjacent
  events exceeds `SESSION_TIMEOUT_MS`; for each session computes `started_at` (first),
  `ended_at` (last), `entry_path`/`exit_path`, `pageviews` (name IS NULL count),
  `events` (name NOT NULL count), `duration_ms = ended_at - started_at`,
  `is_bounce = (pageviews <= 1 ? 1 : 0)`, `channel` = the entry event's channel; upserts into
  `event_sessions` (`INSERT OR REPLACE` on `id`, where `id = sha256(site_id|visitor_hash|started_at)`
  hex, deterministic and idempotent). Sessions never span a UTC day (visitor_hash rotates daily) —
  documented, not a bug. Wire `buildSessions(env, dayKey(now - HOUR_MS))` into `runScheduled` (after
  rollups) via T032's handler (serialization: `rollups.ts`/`index.ts`).
- **Completion:** `sessions.test.ts` seeds events for one visitor with a 40-minute gap and asserts
  two `event_sessions` rows; a single-pageview visitor yields `is_bounce=1`; re-running
  `buildSessions` for the same day produces identical rows (idempotent).

### T049 — Engagement & traffic stats helpers ‖ parallel (after T048)
- **Files:** `apps/server/src/db/stats.ts`, `apps/server/test/engagement-queries.test.ts` (new),
  `packages/shared/src/stats.ts` (add types).
- **Pre-decided details:** Add to `stats.ts`: `engagement(env, f): Promise<EngagementSummary>` where
  `EngagementSummary = { sessions: number; bounce_rate: number; pages_per_session: number; avg_duration_ms: number }`
  computed over `event_sessions` in `[start,end)` (`bounce_rate = bounces/sessions`,
  `pages_per_session = sum(pageviews)/sessions`, `avg_duration_ms = sum(duration_ms)/sessions`;
  all `0` when `sessions===0`). `channels(env, f): Promise<CountRow[]>` = sessions grouped by
  `channel` (exclude `internal`), desc. Add `EngagementSummary` to `@countless/shared`.
- **Completion:** `engagement-queries.test.ts` seeds a fixed set of `event_sessions` and asserts each
  metric to exact values and that `channels` groups/sorts correctly and excludes `internal`.

### T050 — Stats API: engagement + channels endpoints (after T022, T049)
- **Files:** `apps/server/src/routes/stats.ts`, `apps/server/test/stats-engagement.test.ts` (new).
- **Pre-decided details:** `statsRoutes.get('/stats/sessions', requireApiKey, vValidator('query', StatsQuerySchema), …)`
  → `200 { engagement: EngagementSummary }`; `GET /stats/channels` → `200 { channels: CountRow[] }`.
  Also add `engagement` and `channels` into the main `GET /stats` `StatsResponse` (extend the T001
  type + T022 assembler). Example: `{"engagement":{"sessions":42,"bounce_rate":0.31,"pages_per_session":2.7,"avg_duration_ms":95000},"channels":[{"key":"organic","count":20}]}`.
  Same auth/`site_mismatch`/`bad_range` rules as T022.
- **Completion:** `stats-engagement.test.ts`: seeded site+key returns correct `engagement` and
  `channels` from both the dedicated endpoints and the extended `/stats`; wrong-site key → 403.

### T051 — Dashboard: engagement KPIs + channels (after T026, T050)
- **Files:** `apps/dashboard/src/components/EngagementCards.tsx` (new),
  `apps/dashboard/src/components/ChannelsPanel.tsx` (new), `apps/dashboard/src/hooks.ts`,
  `apps/dashboard/src/test/engagement.test.tsx` (new).
- **Pre-decided details:** `EngagementCards` shows Sessions, Bounce Rate (`%`), Pages/Session,
  Avg Duration (`m:ss` via `date-fns`). `ChannelsPanel` reuses `TopList` fed by `channels`. Add
  `useSessions(apiKey, query)` hook (`queryKey ['sessions', query]`).
- **Completion:** `engagement.test.tsx` with mocked hook data asserts the four metrics render with
  correct formatting and the channels list renders one row per channel.

### T052 — E2E acceptance: sessions/engagement/channels (after T047, T048, T050)
- **Files:** `apps/server/test/e2e-engagement.test.ts` (new).
- **Pre-decided details:** Ingest a scripted visitor journey (entry via `?utm_medium=organic`-style
  referrer, 3 pageviews within timeout, then a >30-min gap + 1 more pageview) across the collect
  endpoint; run `buildSessions`; GET `/stats/sessions` + `/stats/channels` and assert exact
  `sessions=2`, `bounce_rate`, `pages_per_session`, and the channel attribution.
- **Completion:** the e2e test passes with exact asserted values.

### T053 — Privacy/security review: UTM capture & sessions (after T047, T048)
- **Files:** `apps/server/test/privacy-phase2.test.ts` (new), `docs/privacy.md` (update).
- **Pre-decided details:** Assert UTM values are stored verbatim only in the declared columns and
  never logged; assert `event_sessions` contains no raw IP/UA and its `id` is a non-reversible hash;
  document in `privacy.md` that UTM parameters are site-supplied marketing tags (not PII by design)
  and that sessions inherit daily un-linkability.
- **Completion:** `privacy-phase2.test.ts` passes all assertions; `privacy.md` has a "Sessions & UTM"
  section.

---

## Phase 3 — Conversions & Funnels

Goal/event conversions, form-submission tracking, and multi-step funnels. Migration `0003`. New
admin CRUD for goals/funnels; new report endpoints. Dashboard gains Conversions + a funnel
visualization (ECharts). No privacy expansion (reuses existing events).

### T054 — Migration 0003: goals & funnels schema
- **Files:** `apps/server/src/db/schema.ts`, `apps/server/migrations/0003_goals_funnels.sql`,
  `apps/server/test/schema-0003.test.ts` (new).
- **Pre-decided details:** `goals`: `id TEXT PK`, `site_id TEXT NOT NULL`, `name TEXT NOT NULL`,
  `type TEXT NOT NULL` (`event|path`), `match_value TEXT NOT NULL`, `created_at INTEGER NOT NULL`;
  index `idx_goals_site (site_id)`. `funnels`: `id TEXT PK`, `site_id TEXT NOT NULL`,
  `name TEXT NOT NULL`, `steps TEXT NOT NULL` (JSON array of `{ type: 'event'|'path', match_value: string }`,
  2–10 entries), `created_at INTEGER NOT NULL`; index `idx_funnels_site (site_id)`. Regenerate.
- **Completion:** `schema-0003.test.ts` asserts both tables exist with the declared columns.

### T055 — Goals admin CRUD ‖ parallel (after T020, T054)
- **Files:** `apps/server/src/routes/goals.ts` (new), `apps/server/src/app.ts`,
  `packages/shared/src/schemas.ts` (add `GoalSchema`), `apps/server/test/goals.test.ts` (new).
- **Pre-decided details:** `GoalSchema = v.object({ site_id: uuid, name: str(1..100), type: v.picklist(['event','path']), match_value: str(1..2048) })`.
  Under `requireAdmin`: `POST /api/goals` → `201 { goal }`; `GET /api/goals?site_id=` →
  `200 { goals: Goal[] }`; `DELETE /api/goals/:id?site_id=` → `200 { deleted: true }` / 404. `Goal`
  type added to `@countless/shared`. Serialization: `app.ts` after T020.
- **Completion:** `goals.test.ts` (admin token) create→list→delete round-trip with correct
  status/bodies; non-admin → 401.

### T056 — Client form-submission tracking ‖ parallel (after T016)
- **Files:** `packages/client/src/auto.ts`, `packages/client/test/forms.test.ts` (new).
- **Pre-decided details:** In `auto.ts`, add a capturing `submit` listener on `document`; on a form
  submit fire `track('form_submit', { form_id: form.id || null, form_name: form.getAttribute('name') || null, action: form.action || null })`.
  Opt-out when the form carries `data-countless-ignore`. No PII from field values is ever read.
- **Completion:** `forms.test.ts` dispatches a `submit` on a mock form and asserts a `form_submit`
  beacon with `form_id`; a form with `data-countless-ignore` fires nothing.

### T057 — Conversion computation + endpoint (after T050, T055)
- **Files:** `apps/server/src/db/conversions.ts` (new), `apps/server/src/routes/stats.ts`,
  `apps/server/test/conversions.test.ts` (new).
- **Pre-decided details:** `goalConversions(env, siteId, goalId, f): Promise<{ conversions: number; sessions: number; rate: number }>`:
  a session "converts" if it contains ≥1 event matching the goal (`type='event'` → `name = match_value`;
  `type='path'` → `path = match_value`); `rate = conversions/sessions` (0 when sessions 0).
  Endpoint `GET /api/stats/conversions?site_id&goal_id&start&end` (`requireApiKey`) →
  `200 { goal_id, conversions, sessions, rate }`.
- **Completion:** `conversions.test.ts` seeds sessions/events and a goal, asserts exact
  `conversions`/`rate`; a path-type goal matches on `path`.

### T058 — Funnels admin CRUD ‖ parallel (after T020, T054)
- **Files:** `apps/server/src/routes/funnels.ts` (new), `apps/server/src/app.ts`,
  `packages/shared/src/schemas.ts` (add `FunnelSchema`), `apps/server/test/funnels-crud.test.ts` (new).
- **Pre-decided details:** `FunnelStepSchema = v.object({ type: v.picklist(['event','path']), match_value: str(1..2048) })`;
  `FunnelSchema = v.object({ site_id: uuid, name: str(1..100), steps: v.pipe(v.array(FunnelStepSchema), v.minLength(2), v.maxLength(10)) })`.
  Under `requireAdmin`: `POST /api/funnels` → `201 { funnel }`; `GET /api/funnels?site_id=`;
  `DELETE /api/funnels/:id?site_id=`. Serialization: `app.ts` after T055.
- **Completion:** `funnels-crud.test.ts` create→list→delete; a 1-step funnel → 400 `validation_failed`.

### T059 — Funnel computation + report endpoint (after T058, T048)
- **Files:** `apps/server/src/db/funnels.ts` (new), `apps/server/src/routes/funnels.ts`,
  `apps/server/test/funnels-report.test.ts` (new).
- **Pre-decided details:** `funnelReport(env, funnel, f): Promise<{ steps: { index: number; match_value: string; count: number }[]; overall_rate: number }>`:
  for each session in range, walk its time-ordered events and advance a step pointer only on an
  in-order match of the next step; `steps[i].count` = number of sessions reaching step `i`;
  `overall_rate = steps[last].count / steps[0].count` (0 when step0 is 0). Endpoint
  `GET /api/funnels/:id/report?site_id&start&end` (`requireApiKey`, enforce `site_id` match) →
  the JSON above. Example: `{"steps":[{"index":0,"match_value":"/","count":100},{"index":1,"match_value":"/pricing","count":40},{"index":2,"match_value":"signup","count":12}],"overall_rate":0.12}`.
- **Completion:** `funnels-report.test.ts` seeds sessions with known step-completion and asserts each
  `steps[i].count` and `overall_rate`; out-of-order events do not count as progression.

### T060 — Dashboard: conversions + funnel viz (after T026, T057, T059, T081a)
- **Files:** `apps/dashboard/src/components/Conversions.tsx` (new),
  `apps/dashboard/src/components/FunnelChart.tsx` (new), `apps/dashboard/src/hooks.ts`,
  `apps/dashboard/src/test/funnel.test.tsx` (new).
- **Pre-decided details:** `FunnelChart` wraps ECharts `series.type='funnel'` fed by the report
  `steps`; `Conversions` lists goals + rates. Hooks `useConversions`, `useFunnelReport`.
- **Completion:** `funnel.test.tsx` with mocked report renders an ECharts funnel node with one datum
  per step and the conversion list.

### T061 — E2E acceptance: conversions + funnels (after T057, T059)
- **Files:** `apps/server/test/e2e-funnels.test.ts` (new).
- **Pre-decided details:** Create a goal + a 3-step funnel (admin), ingest sessions completing 0/1/2/3
  steps, run `buildSessions`, then assert `/stats/conversions` rate and `/funnels/:id/report`
  step counts + `overall_rate` exactly.
- **Completion:** e2e passes with exact values.

---

## Phase 4 — Performance Metrics (Workers Analytics Engine)

Client Web-Vitals/Navigation-Timing capture → AE datapoints → AE-SQL quantiles. Migration: none
(AE, not D1). Promotes the `AE` binding. New endpoints `POST /api/perf`, `GET /api/stats/perf`.

### T062a — Promote Analytics Engine binding + write lib
- **Files:** `apps/server/wrangler.jsonc`, `apps/server/src/env.ts`,
  `apps/server/src/lib/ae.ts` (new), `apps/server/worker-configuration.d.ts`,
  `apps/server/test/ae-write.test.ts` (new).
- **Pre-decided details:** Uncomment/add `"analytics_engine_datasets": [{ "binding": "AE", "dataset": "countless_perf" }]`.
  Extend `Env` with `AE: AnalyticsEngineDataset`, `CF_ACCOUNT_ID: string` (var), `CF_API_TOKEN: string`
  (secret). `ae.ts` (write half): `writePerf(env, sample: { siteId; hostname; path; metric; value })` →
  `env.AE.writeDataPoint({ indexes: [siteId], blobs: [hostname, path, metric], doubles: [value] })`.
  Serialization: `wrangler.jsonc`/`env.ts` (v2 sequence).
- **Completion:** `ae-write.test.ts` stubs `env.AE.writeDataPoint` and asserts `writePerf` builds the
  exact datapoint shape (indexes/blobs/doubles); `wrangler deploy --dry-run` parses the binding.

### T062b — AE-SQL quantile query lib + provisioning docs (after T062a)
- **Files:** `apps/server/src/lib/ae.ts` (query half), `apps/server/test/ae-query.test.ts` (new),
  `docs/self-hosting.md`.
- **Pre-decided details:** `queryPerfQuantiles(env, { siteId, path?, start, end }): Promise<Record<Metric, { p75: number; p95: number; samples: number }>>`
  issues an AE-SQL `POST https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`
  with `Authorization: Bearer ${env.CF_API_TOKEN}`, using `quantileWeighted(double1, 0.75)` /
  `0.95` grouped by `blob3` (metric), filtered on `index1=siteId` and the time range. Document in
  `self-hosting.md` the `CF_API_TOKEN` scope (Account Analytics → Read) and that AE SQL runs on
  Cloudflare's API (on-platform, but requires this token).
- **Completion:** `ae-query.test.ts` stubs `fetch` returning a canned AE-SQL body and asserts
  `queryPerfQuantiles` parses per-metric p75/p95/samples; `self-hosting.md` documents the token.

### T063 — Client Web-Vitals capture (`perf.js`) ‖ parallel (after T017)
- **Files:** `packages/client/src/perf.ts` (new), `packages/client/tsup.config.ts`,
  `packages/client/package.json` (add `web-vitals@4.2.4` dep), `packages/client/test/perf.test.ts` (new).
- **Pre-decided details:** `perf.ts` imports `onLCP,onCLS,onINP,onFCP,onTTFB` from `web-vitals` and,
  plus `PerformanceNavigationTiming` for `load` (`loadEventEnd - startTime`) and `response`
  (`responseEnd - requestStart`), POSTs each metric to `${host}/api/perf` as
  `{ site_id, hostname, path, metric, value }` via `sendBeacon`. Built as a separate `dist/perf.js`
  IIFE (`countless-perf`); the core `script.js` stays zero-dep. Size budget: gzipped `perf.js`
  ≤ 6144 bytes.
- **Completion:** `perf.test.ts` (stubbed web-vitals callbacks + `PerformanceNavigationTiming`)
  asserts a beacon per metric with the correct `metric`/`value`; `pnpm --filter countless build`
  emits `dist/perf.js` under the size budget.

### T064 — `POST /api/perf` ingest → AE (after T007, T062a)
- **Files:** `apps/server/src/routes/perf.ts` (new), `apps/server/src/app.ts`,
  `packages/shared/src/schemas.ts` (add `PerfSampleSchema`), `apps/server/test/perf-ingest.test.ts` (new).
- **Pre-decided details:** `PerfSampleSchema = v.object({ site_id: uuid, hostname: str(1..253), path: str(1..2048,/^\//), metric: v.picklist(PERF_METRICS), value: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(3_600_000)) })`.
  Public, rate-limited (reuse T013 middleware, key = clientIp), CORS `*` like collect,
  `bodyLimit` 1 KB. Handler → `writePerf`; return `c.body(null, 202)`. Bots dropped via `isBot`.
  Serialization: `app.ts` after prior route mounts.
- **Completion:** `perf-ingest.test.ts` posts a valid sample → 202 and asserts `writePerf` invoked
  with the mapped datapoint; an out-of-range `value` → 400; a bot UA → 202 with no write.

### T065 — Perf stats query endpoint (after T062b, T064)
- **Files:** `apps/server/src/routes/stats.ts`, `apps/server/test/perf-stats.test.ts` (new).
- **Pre-decided details:** `GET /api/stats/perf?site_id&path?&start&end` (`requireApiKey`,
  `site_mismatch` guarded) → `200 { perf: Record<Metric, { p75, p95, samples }> }` from
  `queryPerfQuantiles`. Example: `{"perf":{"lcp":{"p75":2100,"p95":3800,"samples":540},"cls":{"p75":0.04,"p95":0.12,"samples":540}}}`.
- **Completion:** `perf-stats.test.ts` stubs `queryPerfQuantiles` and asserts the endpoint returns the
  shape and honors auth; wrong-site key → 403.

### T066 — Dashboard: Web Vitals panel (after T026, T065)
- **Files:** `apps/dashboard/src/components/WebVitals.tsx` (new), `apps/dashboard/src/hooks.ts`,
  `apps/dashboard/src/test/webvitals.test.tsx` (new).
- **Pre-decided details:** `WebVitals` renders p75/p95 per metric with Good/Needs-Improvement/Poor
  color thresholds (fixed: LCP good ≤ 2500 / poor > 4000 ms; CLS ≤ 0.1 / > 0.25; INP ≤ 200 / > 500).
  Hook `usePerf`.
- **Completion:** `webvitals.test.tsx` with mocked data asserts the metric rows render with the
  correct rating class.

### T067 — E2E acceptance: perf ingest → AE → query (after T064, T065)
- **Files:** `apps/server/test/e2e-perf.test.ts` (new).
- **Pre-decided details:** With `env.AE` mocked to capture datapoints and `queryPerfQuantiles`
  computing from the captured set (test double), POST several perf samples then GET
  `/api/stats/perf` and assert the p75/p95 match the injected distribution.
- **Completion:** e2e passes with exact quantiles from the controlled sample set.

---

## Phase 5 — A/B Testing / Experiments

Deterministic variant assignment, exposure + conversion tracking, and two-proportion significance.
Migration `0004`. **Privacy note:** stable cross-day assignment needs a persistent pseudonymous id
(`countless.exp` in localStorage) — a deliberate, documented expansion beyond the daily visitor hash
(the daily hash cannot give stable assignment). Bucketing itself is a pure deterministic function of
that id; a security review (T075) covers the new identifier.

### T068 — Migration 0004: experiments & exposures schema
- **Files:** `apps/server/src/db/schema.ts`, `apps/server/migrations/0004_experiments.sql`,
  `apps/server/test/schema-0004.test.ts` (new).
- **Pre-decided details:** `experiments`: `id TEXT PK`, `site_id TEXT NOT NULL`, `key TEXT NOT NULL`,
  `name TEXT NOT NULL`, `variants TEXT NOT NULL` (JSON `{ key: string; weight: number }[]`, 2–8),
  `status TEXT NOT NULL` (`draft|running|stopped`), `created_at INTEGER NOT NULL`; unique index
  `idx_experiments_site_key (site_id, key)`. `exposures`: `id TEXT PK`, `site_id TEXT NOT NULL`,
  `experiment_id TEXT NOT NULL`, `variant TEXT NOT NULL`, `exp_id TEXT NOT NULL`,
  `converted INTEGER NOT NULL DEFAULT 0`, `created_at INTEGER NOT NULL`; unique index
  `idx_exposures_unique (experiment_id, exp_id)`. Regenerate.
- **Completion:** `schema-0004.test.ts` asserts both tables + the unique indexes.

### T069 — Deterministic bucketing lib ‖ parallel (after T068)
- **Files:** `apps/server/src/lib/experiments.ts` (new), `apps/server/test/bucketing.test.ts` (new).
- **Pre-decided details:** `assignVariant(id: string, experimentKey: string, variants: { key: string; weight: number }[]): string`:
  compute `h = first 8 hex of SHA-256(experimentKey ⧊ id)` → integer `n`; `bucket = n % totalWeight`;
  walk variants accumulating weights, return the variant whose cumulative window contains `bucket`.
  Pure, deterministic, stable for a given `(id, experimentKey)`. (Works on any id; the client passes
  the persistent `exp_id`, not the daily visitor hash, for cross-day stability — documented.)
- **Completion:** `bucketing.test.ts` asserts the same `(id, key)` always yields the same variant;
  a 50/50 split over 10 000 synthetic ids lands within ±2% of even; weights are honored.

### T070 — Experiments admin CRUD + assignment endpoint (after T020, T069)
- **Files:** `apps/server/src/routes/experiments.ts` (new), `apps/server/src/app.ts`,
  `packages/shared/src/schemas.ts` (add `ExperimentSchema`), `apps/server/test/experiments-api.test.ts` (new).
- **Pre-decided details:** Admin CRUD (`requireAdmin`): `POST/GET/DELETE /api/experiments`
  (weights integers ≥1, ≤8 variants). Public assignment (rate-limited, CORS `*`):
  `POST /api/experiments/assign` body `{ site_id, key, exp_id }` → look up the running experiment,
  `assignVariant`, upsert an `exposures` row (idempotent on `(experiment_id, exp_id)`), return
  `200 { variant }`; unknown/stopped experiment → `404 { error: 'not_found' }`. Serialization:
  `app.ts` after prior mounts.
- **Completion:** `experiments-api.test.ts`: create experiment; assign twice with the same `exp_id`
  → identical variant + a single `exposures` row; a `stopped` experiment → 404.

### T071 — Client experiment SDK ‖ parallel (after T016, T070)
- **Files:** `packages/client/src/experiments.ts` (new), `packages/client/tsup.config.ts`,
  `packages/client/test/experiments-client.test.ts` (new).
- **Pre-decided details:** Built into `dist/experiments.js` (ESM export + optional). `getExpId()`
  reads/creates a UUID in `localStorage[EXPERIMENT_ID_KEY]`. `assign(key): Promise<string>` POSTs to
  `/api/experiments/assign` with `{ site_id, key, exp_id }` and returns the variant.
  `convert(experimentKey)` fires `track('experiment_conversion', { key })` for results attribution.
- **Completion:** `experiments-client.test.ts` (stubbed fetch + localStorage) asserts a stable
  `exp_id` persists across calls and `assign` returns the server variant.

### T072 — Results + significance endpoint (after T070)
- **Files:** `apps/server/src/lib/stats-math.ts` (new), `apps/server/src/routes/experiments.ts`,
  `apps/server/test/significance.test.ts` (new).
- **Pre-decided details:** `twoProportionZ(aConv, aN, bConv, bN): { z: number; pValue: number; significant: boolean }`
  (pooled proportion; `significant = pValue < SIGNIFICANCE_ALPHA`; normal-CDF via a fixed rational
  approximation). Endpoint `GET /api/experiments/:id/results?site_id` (`requireApiKey`) →
  `200 { variants: { key, exposures, conversions, rate }[], comparisons: { control, variant, z, pValue, significant }[] }`
  (control = first variant; conversions counted from `exposures.converted`, updated by a small
  matcher that marks `converted=1` when the visitor later fires `experiment_conversion`).
- **Completion:** `significance.test.ts` asserts `twoProportionZ` on textbook inputs matches expected
  z/p (±1e-3) and the endpoint returns per-variant rates + a significance verdict.

### T073 — Dashboard: experiments UI (after T026, T072)
- **Files:** `apps/dashboard/src/components/Experiments.tsx` (new), `apps/dashboard/src/hooks.ts`,
  `apps/dashboard/src/test/experiments.test.tsx` (new).
- **Pre-decided details:** Lists experiments with per-variant exposure/conversion/rate and a
  significance badge (green when `significant`). Hook `useExperimentResults`.
- **Completion:** `experiments.test.tsx` with mocked results renders one row per variant and a
  "significant" badge when the flag is set.

### T074 — E2E acceptance: experiment lifecycle (after T070, T072)
- **Files:** `apps/server/test/e2e-experiments.test.ts` (new).
- **Pre-decided details:** Create a running 50/50 experiment, assign many synthetic `exp_id`s, fire
  conversions for a known subset, then GET results and assert per-variant rates + the significance
  verdict against the injected effect.
- **Completion:** e2e passes with the expected verdict and rates.

### T075 — Privacy/security review: persistent experiment id (after T070, T071)
- **Files:** `apps/server/test/privacy-experiments.test.ts` (new), `docs/privacy.md` (update).
- **Pre-decided details:** Assert `exp_id` is a random UUID (no IP/UA derivation), is never joined to
  `visitor_hash` server-side, and that `exposures` stores no PII. Document the experiment id as a
  first-party, experiment-scoped pseudonymous identifier, its opt-out (`localStorage.removeItem`),
  and that it is absent unless the experiments SDK is loaded.
- **Completion:** `privacy-experiments.test.ts` passes; `privacy.md` has an "A/B testing identifier"
  section.

---

## Phase 6 — Real-time Live Path (Durable Objects + WebSockets)

Live, sub-second event stream via one hibernatable-WebSocket Durable Object per site, fed from the
collect handler; batch rollups remain the historical source of truth. Promotes the `durable_objects`
binding (migration tag `v2`). New endpoint `GET /api/live` (WebSocket upgrade).

### T076 — Promote Durable Objects binding + `LiveHub` class
- **Files:** `apps/server/wrangler.jsonc`, `apps/server/src/do/live-hub.ts` (new),
  `apps/server/src/index.ts` (export `LiveHub`), `apps/server/src/env.ts`,
  `apps/server/test/live-hub.test.ts` (new).
- **Pre-decided details:** Uncomment `"durable_objects": { "bindings": [{ "name": "LIVE", "class_name": "LiveHub" }] }`
  and `"migrations": [{ "tag": "v2", "new_sqlite_classes": ["LiveHub"] }]`. Extend `Env` with
  `LIVE: DurableObjectNamespace`. `LiveHub` uses **hibernatable WebSockets**
  (`state.acceptWebSocket`), keeps an in-memory ring of events within `LIVE_WINDOW_MS`, exposes
  `POST /push` (append + broadcast JSON to all sockets) and `GET /subscribe` (WS upgrade + replay of
  the current window). `rehydrate` the window from `state.storage` in `blockConcurrencyWhile` (the
  documented hibernation-safety fix). Serialization: `wrangler.jsonc`, `env.ts`, `index.ts`.
- **Completion:** `live-hub.test.ts` (pool-workers DO access via `runInDurableObject`) asserts a
  pushed event is retained within the window and evicted after it; two `/push` calls broadcast to a
  connected socket.

### T077 — Live fan-out from collect (after T014, T076)
- **Files:** `apps/server/src/routes/collect.ts`, `apps/server/test/live-fanout.test.ts` (new).
- **Pre-decided details:** After a successful non-bot insert, `c.executionCtx.waitUntil(env.LIVE.get(env.LIVE.idFromName(body.site_id)).fetch('https://live/push', { method: 'POST', body: JSON.stringify({ t: now, path: body.path, name: body.name ?? null, country, device }) }))`.
  No raw IP/visitor_hash is sent to the DO (privacy: live view is aggregate/anonymous). Failure to
  reach the DO must never fail the collect response.
- **Completion:** `live-fanout.test.ts` posts a valid event and asserts the site's `LiveHub` received
  one push with no `ip`/`visitor_hash` field; a bot event pushes nothing.

### T078 — WebSocket endpoint `GET /api/live` (after T019, T076)
- **Files:** `apps/server/src/routes/live.ts` (new), `apps/server/src/app.ts`,
  `apps/server/test/live-ws.test.ts` (new).
- **Pre-decided details:** `GET /api/live?site_id&key` — validate `Upgrade: websocket`, authenticate
  the key via `authenticateKey` (query param, since browsers can't set WS headers) and enforce
  `site_id` match, then forward the upgrade to `env.LIVE.get(idFromName(site_id)).fetch('https://live/subscribe', request)`.
  Non-WS request → 426; bad key → 401. Serialization: `app.ts`.
- **Completion:** `live-ws.test.ts` opens a WS to the endpoint with a valid key, triggers a collect,
  and asserts a live message arrives; a bad key → 401; a plain GET → 426.

### T079 — Dashboard: real-time view (after T026, T078)
- **Files:** `apps/dashboard/src/components/LiveView.tsx` (new),
  `apps/dashboard/src/lib/live-socket.ts` (new), `apps/dashboard/src/test/live.test.tsx` (new).
- **Pre-decided details:** `live-socket.ts` opens `new WebSocket(\`\${wsBase}/api/live?site_id=\${siteId}&key=\${key}\`)`
  with auto-reconnect (fixed backoff 1s→10s cap) and exposes an event callback. `LiveView` shows a
  rolling "active in last 30 min" count and a live path ticker.
- **Completion:** `live.test.tsx` with a mock WebSocket pushing events asserts the live count and
  ticker update.

### T080 — E2E acceptance: live path (after T077, T078)
- **Files:** `apps/server/test/e2e-live.test.ts` (new).
- **Pre-decided details:** Connect a WS with a valid key, POST a non-bot collect, and assert the exact
  event (path/country/device, no PII) is delivered live; assert a bot event delivers nothing.
- **Completion:** e2e passes.

---

## Phase 7 — Interactive Dashboards & Visualizations

Upgrades the dashboard to interactive, filterable, drill-down analytics across all existing
endpoints. Adds ECharts + routing + a global filter bar; extends every stats endpoint with a unified
filter contract. No server schema change beyond the shared filter params.

### T081a — ECharts wrapper primitive ‖ parallel (after T026)
- **Files:** `apps/dashboard/package.json` (add `echarts@5.5.1`),
  `apps/dashboard/src/components/EChart.tsx` (new, canonical — see DRY mandate),
  `apps/dashboard/src/test/echart.test.tsx` (new).
- **Pre-decided details:** `EChart` is the single ECharts wrapper: `echarts.init` on a `useRef`
  container, `setOption(props.option)` on change, `ResizeObserver` for width, `dispose()` on unmount.
  All advanced visualizations (funnel T060, sentiment T097, heatmaps) reuse this — no component calls
  `echarts.init` directly. uPlot remains the time-series renderer.
- **Completion:** `echart.test.tsx` asserts `EChart` mounts an ECharts instance for a given `option`
  and disposes it on unmount (no leak).

### T081b — Global filter bar + filter state ‖ parallel (after T026)
- **Files:** `apps/dashboard/package.json` (add `react-router-dom@6.28.0`),
  `apps/dashboard/src/state.ts`, `apps/dashboard/src/components/FilterBar.tsx` (new),
  `apps/dashboard/src/test/filterbar.test.tsx` (new).
- **Pre-decided details:** `FilterBar` exposes dimension filters `{ hostname?, path?, country?, device?, channel? }`
  held in URL query + context (`state.ts`, `useFilters()` hook); every feature hook reads the active
  filter and folds it into its query object. This is the single filter-state source; components never
  hold their own filter copies.
- **Completion:** `filterbar.test.tsx` asserts selecting a device filter updates the URL + context and
  the `useFilters()`-derived query object; clearing it resets both.

### T082 — Unified filter params across stats endpoints (after T022, T050, T081b)
- **Files:** `packages/shared/src/schemas.ts` (extend `StatsQuerySchema`),
  `apps/server/src/db/stats.ts`, `apps/server/src/routes/stats.ts`,
  `apps/server/test/stats-filters.test.ts` (new).
- **Pre-decided details:** Extend `StatsQuerySchema`/`StatsFilter` with optional `path`, `country`,
  `device`, `channel` (each validated, applied as additional `WHERE` predicates in every T021/T049
  helper). Backward compatible (all optional). Serialization: `stats.ts`, `schemas.ts`.
- **Completion:** `stats-filters.test.ts` seeds mixed data and asserts each filter narrows `summary`,
  `series`, and top-lists to exactly the matching subset.

### T083 — Drill-down + period comparison (after T081b, T082)
- **Files:** `apps/dashboard/src/components/Drilldown.tsx` (new),
  `apps/dashboard/src/components/CompareToggle.tsx` (new), `apps/dashboard/src/hooks.ts`,
  `apps/dashboard/src/test/drilldown.test.tsx` (new).
- **Pre-decided details:** Clicking a top-list row pushes that dimension into the `FilterBar`
  (drill-down). `CompareToggle` fetches the immediately preceding equal-length period and renders
  delta % on KPI cards (fixed: previous period = `[start-(end-start), start)`).
- **Completion:** `drilldown.test.tsx` asserts a row click adds the filter and refetches; compare
  mode shows a delta computed from two mocked responses.

### T084 — Dashboard routes + saved views (after T081b)
- **Files:** `apps/dashboard/src/App.tsx`, `apps/dashboard/src/routes.tsx` (new),
  `apps/dashboard/src/test/routes.test.tsx` (new).
- **Pre-decided details:** `react-router-dom` routes: `/` (overview), `/engagement`, `/conversions`,
  `/funnels`, `/experiments`, `/performance`, `/live`, `/insights`, `/social` (each rendered only
  when its phase ships; unshipped routes are omitted, not stubbed). Saved views persist the current
  filter set to `localStorage['countless.views']`. SPA fallback (T028) already serves these paths.
- **Completion:** `routes.test.tsx` asserts navigation renders the correct panel and a saved view
  restores its filters.

### T085 — E2E acceptance: interactive filter/drill-down (after T082, T083)
- **Files:** `apps/dashboard/src/test/e2e-interactive.test.tsx` (new).
- **Pre-decided details:** With a mocked API layer, apply a device filter + drill into a path and
  assert every panel’s query object carries both predicates and the rendered numbers reflect the
  filtered mock dataset.
- **Completion:** the interactive e2e passes.

---

## Phase 8 — AI/ML Insights (Workers AI)

Statistical anomaly detection (deterministic) + Workers-AI natural-language trend summaries, written
by the scheduled handler into an `insights` feed. Migration `0005`. Promotes the `AI` binding.

### T086 — Migration 0005: insights schema + AI binding + shared AI wrapper
- **Files:** `apps/server/src/db/schema.ts`, `apps/server/migrations/0005_insights.sql`,
  `apps/server/wrangler.jsonc`, `apps/server/src/env.ts`, `apps/server/src/lib/ai.ts` (new, canonical
  — see DRY mandate), `apps/server/test/schema-0005.test.ts` (new),
  `apps/server/test/ai.test.ts` (new).
- **Pre-decided details:** `insights`: `id TEXT PK`, `site_id TEXT NOT NULL`, `type TEXT NOT NULL`
  (`anomaly|trend|summary`), `severity TEXT NOT NULL` (`info|warning|critical`), `metric TEXT NOT NULL`,
  `window_start INTEGER NOT NULL`, `window_end INTEGER NOT NULL`, `score REAL`, `text TEXT NOT NULL`,
  `created_at INTEGER NOT NULL`; index `idx_insights_site_created (site_id, created_at)`. Add
  `"ai": { "binding": "AI" }` to wrangler; extend `Env` with `AI: Ai`. `ai.ts` is the single home for
  the pinned model ids and calls: `classifySentiment(env, text): Promise<{ label: 'positive'|'neutral'|'negative'; score: number }>`
  (`@cf/huggingface/distilbert-sst-2-int8`), `embed(env, text): Promise<number[]>`
  (`@cf/baai/bge-base-en-v1.5`, 768-dim), `summarize(env, prompt): Promise<string>`
  (`@cf/meta/llama-3.1-8b-instruct`). No other module calls `env.AI.run` directly. Regenerate.
  Serialization: `schema.ts`, `wrangler.jsonc`, `env.ts`.
- **Completion:** `schema-0005.test.ts` asserts the table; `wrangler deploy --dry-run` parses `AI`;
  `ai.test.ts` stubs `env.AI.run` and asserts each wrapper maps inputs/outputs correctly (sentiment
  label mapping, embedding length 768).

### T087 — Statistical anomaly detection ‖ parallel (after T086)
- **Files:** `apps/server/src/lib/anomaly.ts` (new), `apps/server/test/anomaly.test.ts` (new).
- **Pre-decided details:** `detectAnomalies(env, siteId, now): Promise<Anomaly[]>` reads the last 24
  hourly `event_rollups` for the site, computes mean/stddev of `pageviews`, and flags the latest
  bucket when `|value-mean|/stddev >= ANOMALY_Z` (`severity`: `warning` at z≥3, `critical` at z≥5);
  pure math (no model). Returns `{ metric, score, window_start, window_end, direction }[]`.
- **Completion:** `anomaly.test.ts` feeds a flat series + one spike and asserts exactly one anomaly
  with the correct z-score and window; a flat series yields none.

### T088a — Insights writer (anomaly persistence) (after T086, T087)
- **Files:** `apps/server/src/lib/insights.ts` (new), `apps/server/test/insights-writer.test.ts` (new).
- **Pre-decided details:** `writeAnomalyInsights(env, siteId, now)`: run `detectAnomalies` (T087) and
  persist each as an `insights` row (`type='anomaly'`, `severity` from the z-score, `metric`,
  `window_*`, `score`, `text` = a deterministic templated sentence — no LLM here). Idempotent per
  `(site_id, metric, window_start, type)`.
- **Completion:** `insights-writer.test.ts` seeds rollups with a spike and asserts exactly one
  `anomaly` row with the correct severity/score/window; a flat series writes none; re-running does not
  duplicate.

### T088b — Workers-AI trend summary + scheduled job (after T088a, T032, T086)
- **Files:** `apps/server/src/lib/insights.ts` (summary half), `apps/server/src/lib/scheduled.ts`
  (register job — reuse the T032 registry), `apps/server/test/insights-summary.test.ts` (new).
- **Pre-decided details:** `generateSummary(env, siteId, now)`: build a compact digest (today vs
  7-day baseline) and call `summarize(env, prompt)` (shared `ai.ts` T086) for a ≤ 60-word `summary`
  insight; persist it. `generateInsights(env, siteId, now)` = `writeAnomalyInsights` + `generateSummary`.
  Registered as a scheduled job `daily-insights` via `registerJob`, guarded to run only in the first
  cron hour of the UTC day (no edit to `runScheduled`). LLM output is non-deterministic → tests assert
  structure, not text.
- **Completion:** `insights-summary.test.ts` stubs `ai.ts` `summarize` to a fixed string and asserts a
  non-empty `summary` row is written and the job is registered in `JOBS`.

### T089 — Insights API endpoint (after T086)
- **Files:** `apps/server/src/routes/stats.ts`, `apps/server/test/insights-api.test.ts` (new).
- **Pre-decided details:** `GET /api/insights?site_id&limit=20` (`requireApiKey`, `site_mismatch`
  guarded) → `200 { insights: Insight[] }` newest-first. `Insight` type added to `@countless/shared`.
- **Completion:** `insights-api.test.ts` seeds insights and asserts newest-first ordering, the `limit`
  cap, and auth enforcement.

### T090 — Dashboard: insights feed (after T026, T089)
- **Files:** `apps/dashboard/src/components/InsightsFeed.tsx` (new), `apps/dashboard/src/hooks.ts`,
  `apps/dashboard/src/test/insights.test.tsx` (new).
- **Pre-decided details:** Renders insight cards with a severity color + relative time (`date-fns`);
  hook `useInsights`.
- **Completion:** `insights.test.tsx` with mocked insights renders one card per row with the correct
  severity styling.

### T091 — E2E acceptance: anomaly → insight → feed (after T088b, T089)
- **Files:** `apps/server/test/e2e-insights.test.ts` (new).
- **Pre-decided details:** Seed rollups with a spike, stub `env.AI.run`, run `generateInsights`, then
  GET `/api/insights` and assert the anomaly + summary rows surface with the expected metric/severity.
- **Completion:** e2e passes.

---

## Phase 9 — Social Listening / Opinion Mining (Queues + Workers AI + Vectorize)

Ingest mentions → sentiment + embeddings (Workers AI) → clustering (Vectorize) → storage (D1/R2) →
dashboard. Migration `0006`. **Data-source honesty:** the reference connector fetches **public
RSS/Atom** natively (no provider key). Authenticated social APIs (X/Twitter, Reddit, Meta, etc.)
**cannot stay Cloudflare-native** — they require external, credentialed, often paid provider APIs;
the connector interface accommodates them but each such connector is explicitly flagged external and
ships disabled without its provider secret. Everything downstream (Queues, NLP, Vectorize, storage,
UI) is 100% Cloudflare-native.

### T092 — Migration 0006: mentions schema + Queues/Vectorize/R2 bindings
- **Files:** `apps/server/src/db/schema.ts`, `apps/server/migrations/0006_social.sql`,
  `apps/server/wrangler.jsonc`, `apps/server/src/env.ts`, `docs/self-hosting.md`,
  `apps/server/test/schema-0006.test.ts` (new).
- **Pre-decided details:** `sources`: `id TEXT PK`, `site_id TEXT NOT NULL`, `kind TEXT NOT NULL`
  (`rss|external`), `url TEXT NOT NULL`, `provider TEXT` (null for rss), `enabled INTEGER NOT NULL DEFAULT 1`,
  `created_at INTEGER NOT NULL`. `mentions`: `id TEXT PK`, `site_id TEXT NOT NULL`, `source_id TEXT NOT NULL`,
  `source_url TEXT NOT NULL`, `author_hash TEXT`, `content TEXT NOT NULL`, `lang TEXT`,
  `sentiment REAL`, `sentiment_label TEXT` (`positive|neutral|negative`), `cluster_id INTEGER`,
  `published_at INTEGER`, `ingested_at INTEGER NOT NULL`; index `idx_mentions_site_published (site_id, published_at)`.
  Add wrangler bindings: `"queues": { "producers": [{ "binding": "SOCIAL_QUEUE", "queue": "countless-social" }], "consumers": [{ "queue": "countless-social", "max_batch_size": 20, "max_batch_timeout": 10 }] }`,
  `"vectorize": [{ "binding": "MENTIONS_INDEX", "index_name": "countless-mentions" }]`,
  `"r2_buckets": [{ "binding": "RAW", "bucket_name": "countless-raw" }]`. Extend `Env` accordingly
  (`SOCIAL_QUEUE: Queue`, `MENTIONS_INDEX: VectorizeIndex`, `RAW: R2Bucket`). Author identifiers are
  stored **hashed only** (`author_hash = sha256Hex(author ⧊ site_id)` via `crypto.ts`), never raw.
  Regenerate. Document the provisioning commands in `docs/self-hosting.md`:
  `wrangler queues create countless-social`,
  `wrangler vectorize create countless-mentions --dimensions=768 --metric=cosine`,
  `wrangler r2 bucket create countless-raw`.
- **Completion:** `schema-0006.test.ts` asserts both tables; `wrangler deploy --dry-run` parses the
  Queue/Vectorize/R2 bindings; `self-hosting.md` lists the three provisioning commands.

### T093a — Connector interface + RSS parser ‖ parallel (after T092)
- **Files:** `apps/server/src/social/connector.ts` (new, interface),
  `apps/server/src/social/rss.ts` (new), `apps/server/package.json` (add `fast-xml-parser@4.5.0`),
  `apps/server/test/rss-parser.test.ts` (new).
- **Pre-decided details:** `interface RawMention { source_url: string; author: string | null; content: string; lang: string | null; published_at: number | null }`
  and `interface SourceConnector { kind: string; fetchItems(source: Source): Promise<RawMention[]> }`.
  `rss.ts` implements the connector over native `fetch` + `fast-xml-parser@4.5.0` (public RSS/Atom, no
  provider key). Authenticated-provider connectors are represented by a single stub that
  `throw new Error('external_connector_requires_credentials')` until an operator secret is set —
  clearly flagged external, disabled by default. Pure parsing (network via injected fetch in tests).
- **Completion:** `rss-parser.test.ts` feeds a canned RSS + a canned Atom document and asserts the
  parsed `RawMention[]` (url/author/content/published_at); the external stub throws the documented
  error when no credential is present.

### T093b — Ingestion pipeline: poller cron + R2 archive + enqueue (after T093a)
- **Files:** `apps/server/src/social/poller.ts` (new), `apps/server/src/lib/scheduled.ts`
  (register job — reuse the T032 registry), `apps/server/test/social-poller.test.ts` (new).
- **Pre-decided details:** `pollSources(env, now)` enumerates enabled `sources`, calls each
  connector's `fetchItems`, dedups by `source_url` (skip already-stored `mentions`), archives each
  raw item to `RAW` (R2, key `raw/<site_id>/<sha256(source_url)>.json`), and enqueues
  `{ site_id, source_id, raw }` to `SOCIAL_QUEUE`. Registered as a scheduled job named `social-poll`
  via `registerJob` (no edit to `runScheduled`). Dedup + R2 key reuse `crypto.ts` `sha256Hex`.
- **Completion:** `social-poller.test.ts` (mocked connector + R2 + Queue) asserts new items are
  enqueued and archived to R2, already-seen `source_url`s are skipped, and the job is registered in
  `JOBS`.

### T094a — Queue consumer + sentiment + mentions insert (after T086, T093b)
- **Files:** `apps/server/src/social/score.ts` (new), `apps/server/src/index.ts` (`queue` consumer),
  `apps/server/test/social-sentiment.test.ts` (new).
- **Pre-decided details:** Wire the Worker `queue(batch, env)` consumer in `index.ts` (after T076's DO
  export). For each message: `classifySentiment(env, content)` (shared `ai.ts` T086) → `sentiment`
  (`positive→+score`, `negative→−score`, `neutral→0`) + `sentiment_label`; insert the `mentions` row
  with `author_hash = sha256Hex(author ⧊ site_id)` (shared `crypto.ts`), `id = sha256Hex(source_url)`
  (idempotent). No direct `env.AI.run` calls (use `ai.ts`).
- **Completion:** `social-sentiment.test.ts` stubs `ai.ts` `classifySentiment`; asserts a processed
  message writes a `mentions` row with the mapped `sentiment_label`, a hashed (never raw) author, and
  idempotency on re-delivery of the same `source_url`.

### T094b — Embeddings + Vectorize upsert (after T094a)
- **Files:** `apps/server/src/social/score.ts` (embedding half),
  `apps/server/test/social-embed.test.ts` (new).
- **Pre-decided details:** In the same consumer path, after the row is written, `embed(env, content)`
  (shared `ai.ts`) → 768-dim vector; `MENTIONS_INDEX.upsert([{ id, values, metadata: { site_id } }])`.
  Failures here are logged (T031) and never drop the already-persisted `mentions` row.
- **Completion:** `social-embed.test.ts` stubs `ai.ts` `embed` + `MENTIONS_INDEX.upsert`; asserts an
  embedding of length 768 is upserted with the mention id and `site_id` metadata.

### T095 — Clustering via Vectorize (after T094b)
- **Files:** `apps/server/src/social/cluster.ts` (new), `apps/server/test/social-cluster.test.ts` (new).
- **Pre-decided details:** `assignCluster(env, mentionId, vector): Promise<number>`: query
  `MENTIONS_INDEX.query(vector, { topK: 5 })`; if the nearest neighbor’s score ≥ `0.85` reuse its
  `cluster_id`, else allocate a new incremental `cluster_id` (from a `MAX(cluster_id)+1` over
  `mentions`); update the row. Deterministic given fixed vectors + threshold.
- **Completion:** `social-cluster.test.ts` stubs Vectorize query results; asserts a near-duplicate
  (score ≥ 0.85) joins the existing cluster and a dissimilar vector starts a new cluster id.

### T096 — Social API endpoints (after T094a)
- **Files:** `apps/server/src/routes/social.ts` (new), `apps/server/src/app.ts`,
  `packages/shared/src/schemas.ts` (add `SourceSchema`), `apps/server/test/social-api.test.ts` (new).
- **Pre-decided details:** Admin (`requireAdmin`): `POST/GET/DELETE /api/social/sources`. Read
  (`requireApiKey`): `GET /api/social/mentions?site_id&start&end&sentiment?` → `200 { mentions }`;
  `GET /api/social/sentiment?site_id&start&end` → `200 { series: { t, positive, neutral, negative }[] }`;
  `GET /api/social/clusters?site_id&start&end` → `200 { clusters: { cluster_id, count, sample: string }[] }`.
  Serialization: `app.ts`.
- **Completion:** `social-api.test.ts` seeds mentions and asserts the sentiment series, cluster
  aggregation, and auth (admin for sources, key for reads).

### T097 — Dashboard: social listening view (after T081a, T096)
- **Files:** `apps/dashboard/src/components/Social.tsx` (new), `apps/dashboard/src/hooks.ts`,
  `apps/dashboard/src/test/social.test.tsx` (new).
- **Pre-decided details:** Sentiment trend (ECharts stacked area pos/neu/neg), a clusters panel
  (`TopList` by count), and a mentions list with sentiment badges; hooks `useSentiment`,
  `useClusters`, `useMentions`.
- **Completion:** `social.test.tsx` with mocked data renders the stacked sentiment chart and one
  cluster row per cluster.

### T098 — E2E acceptance: ingest → score → cluster → query (after T093b, T094b, T095, T096)
- **Files:** `apps/server/test/e2e-social.test.ts` (new).
- **Pre-decided details:** Feed a canned RSS batch through the queue consumer (AI + Vectorize stubbed
  deterministically), then GET the sentiment series + clusters and assert counts, labels, and cluster
  grouping match the injected fixtures.
- **Completion:** e2e passes with exact aggregates.

### T099 — Privacy/legal review: third-party content & provider ToS (after T094a, T096)
- **Files:** `apps/server/test/privacy-social.test.ts` (new), `docs/privacy.md`,
  `docs/social-sources.md` (new).
- **Pre-decided details:** Assert authors are stored hashed only and raw connector payloads live in
  R2 with retention (add `enforceSocialRetention` deleting `mentions`/R2 objects older than
  `RAW_RETENTION_DAYS`). Document that social content is third-party/public data, that
  authenticated-provider connectors are external and governed by each provider’s ToS/rate limits, and
  that no such connector ships enabled without an explicit operator-supplied credential.
- **Completion:** `privacy-social.test.ts` passes (hashed authors, retention deletes stale
  mentions + R2 objects); `docs/social-sources.md` lists which sources are native vs external.

---

## Dependency Table

`‖` in the Wave sections marks tasks parallelizable within their wave once their Blocked-by set is
satisfied (respecting the Parallelization Guide's serialization points). This table is authoritative.

| Task | Title | Blocked by |
| --- | --- | --- |
| T001 | Shared event, stats, error types | — |
| T002 | Shared valibot schemas + limits | — |
| T003 | Drizzle schema → D1 migration | — |
| T004 | Env + constants + wrangler bindings + types | — |
| T005 | Fix root/workspace scripts + version pins | — |
| T006 | Worker test harness (migrations, fixtures) | T003, T004 |
| T007 | Hono app shell (errors, CORS, body limit) | T004 |
| T008 | Daily salt | T003, T006, T009 |
| T009 | Crypto primitives + visitor hash | T004 |
| T010 | Bot filtering | T004 |
| T011 | Request metadata (ip/country/device) | T004 |
| T012 | Event insert + session upsert | T003, T006 |
| T013 | Rate-limit middleware | T004, T007 |
| T014 | POST /api/collect | T002, T007, T008, T009, T010, T011, T012, T013 |
| T015 | Client track() core | T001, T002 |
| T016 | Auto-init + umami shim | T015 |
| T017 | Client build + size budget | T015, T016 |
| T018 | API key issuance + hashing | T003, T006, T009 |
| T019 | Auth middleware (key + admin) | T007, T018, T009 |
| T020 | Sites & keys admin endpoints | T002, T007, T018, T019 |
| T021 | Stats query helpers | T006, T012 |
| T022 | GET /api/stats | T002, T019, T021 |
| T023 | Dashboard tooling | T001 |
| T024 | Dashboard API client + hooks | T022, T023 |
| T025 | Layout + key gate + controls | T023 |
| T026 | KPI cards + chart | T024, T025 |
| T027 | Top lists + breakdowns | T024, T025 |
| T028 | Serve dashboard from Worker | T007, T026, T027 |
| T029 | Rollup aggregation | T006, T021 |
| T030 | Retention cleanup | T006 |
| T031 | Structured logging / observability | T004 |
| T032 | Scheduled handler wiring | T029, T030, T031 |
| T033 | CLI dispatch | T001 |
| T034 | countless init | T033 |
| T035 | countless migrate | T033 |
| T036 | countless stats | T033 |
| T037 | Local-dev seed data | T003 |
| T038 | Privacy & security review | T014, T032 |
| T039 | Docs | T014, T020, T022, T032 |
| T040 | README + deploy button | T028, T039 |
| T041 | CHANGELOG + version alignment | T039 |
| T042 | CI + release workflow | T005, T001–T037 (all code) |
| T043 | End-to-end acceptance test | T014, T022, T028, T032 |
| **Phase 2 — Sessions, Engagement & Traffic Sources** | | |
| T044 | Migration 0002: sessions & traffic schema | T003, T006 |
| T045 | Traffic-source classification + UTM lib | T004 |
| T046 | Client UTM capture | T002, T015 |
| T047 | Collect: persist utm + channel | T014, T044, T045, T046 |
| T048 | Sessionization builder (cron) | T044, T032, T009 |
| T049 | Engagement & traffic stats helpers | T021, T048 |
| T050 | Stats API: engagement + channels | T022, T049 |
| T051 | Dashboard: engagement + channels | T026, T050 |
| T052 | E2E: sessions/engagement/channels | T047, T048, T050 |
| T053 | Privacy review: UTM & sessions | T047, T048 |
| **Phase 3 — Conversions & Funnels** | | |
| T054 | Migration 0003: goals & funnels | T003, T006 |
| T055 | Goals admin CRUD | T020, T054 |
| T056 | Client form-submission tracking | T016 |
| T057 | Conversion computation + endpoint | T050, T055 |
| T058 | Funnels admin CRUD | T020, T054 |
| T059 | Funnel computation + report | T058, T048 |
| T060 | Dashboard: conversions + funnel viz | T026, T057, T059, T081a |
| T061 | E2E: conversions + funnels | T057, T059 |
| **Phase 4 — Performance Metrics (Analytics Engine)** | | |
| T062a | Promote AE binding + write lib | T004, T006 |
| T062b | AE-SQL quantile query + docs | T062a |
| T063 | Client Web-Vitals (`perf.js`) | T017 |
| T064 | POST /api/perf → AE | T007, T062a |
| T065 | Perf stats query endpoint | T062b, T064 |
| T066 | Dashboard: Web Vitals panel | T026, T065 |
| T067 | E2E: perf ingest → AE → query | T064, T065 |
| **Phase 5 — A/B Testing** | | |
| T068 | Migration 0004: experiments | T003, T006 |
| T069 | Deterministic bucketing lib | T068, T009 |
| T070 | Experiments CRUD + assign endpoint | T020, T069 |
| T071 | Client experiment SDK | T016, T070 |
| T072 | Results + significance endpoint | T070 |
| T073 | Dashboard: experiments UI | T026, T072 |
| T074 | E2E: experiment lifecycle | T070, T072 |
| T075 | Privacy review: experiment id | T070, T071 |
| **Phase 6 — Real-time Live Path (DO + WS)** | | |
| T076 | Promote DO binding + `LiveHub` | T004, T006 |
| T077 | Live fan-out from collect | T014, T076 |
| T078 | WebSocket endpoint /api/live | T019, T076 |
| T079 | Dashboard: real-time view | T026, T078 |
| T080 | E2E: live path | T077, T078 |
| **Phase 7 — Interactive Dashboards** | | |
| T081a | ECharts wrapper primitive | T026 |
| T081b | Global filter bar + filter state | T026 |
| T082 | Unified filter params (stats) | T022, T050, T081b |
| T083 | Drill-down + period comparison | T081b, T082 |
| T084 | Dashboard routes + saved views | T081b |
| T085 | E2E: interactive filter/drill-down | T082, T083 |
| **Phase 8 — AI/ML Insights (Workers AI)** | | |
| T086 | Migration 0005: insights + AI binding + `ai.ts` | T003, T006 |
| T087 | Statistical anomaly detection | T086, T029 |
| T088a | Insights writer (anomaly persist) | T086, T087 |
| T088b | AI summary + scheduled job | T088a, T032, T086 |
| T089 | Insights API endpoint | T086 |
| T090 | Dashboard: insights feed | T026, T089 |
| T091 | E2E: anomaly → insight → feed | T088b, T089 |
| **Phase 9 — Social Listening / Opinion Mining** | | |
| T092 | Migration 0006: mentions + Q/Vec/R2 | T003, T006, T009 |
| T093a | Connectors + RSS parser | T092 |
| T093b | Poller cron + R2 + enqueue | T093a, T032 |
| T094a | Queue consumer + sentiment + insert | T086, T093b, T076 |
| T094b | Embeddings + Vectorize upsert | T094a |
| T095 | Clustering via Vectorize | T094b |
| T096 | Social API endpoints | T094a |
| T097 | Dashboard: social listening view | T081a, T096 |
| T098 | E2E: ingest → score → cluster → query | T093b, T094b, T095, T096 |
| T099 | Privacy/legal review: social | T094a, T096 |

### Critical path

`T003/T004 → T006 → T012 → T014` and, in parallel, `T006 → T021 → T022`; the dashboard chain
`T023 → T024 → {T026, T027} → T028`; the cron chain `{T029, T030, T031} → T032`. All converge at
**T038/T043**. The longest single chain is:
`T003 → T006 → T021 → T022 → T024 → T026 → T028 → T043` (with `T004 → T007` feeding T013/T014 on a
parallel strand of equal-ish length via `T014`). Optimize wall-clock by starting T001–T005
simultaneously and getting **T006 green as early as possible** — everything server-side tests through
it.

### Parallelization Guide (multi-agent safety)

Genuinely conflict-free parallel groups (distinct files, no shared writes):

- **Wave 0 opener:** T001, T002, T003, T004, T005 in parallel — they touch disjoint files
  (`shared/*`; `server/db` + `env.ts` + `wrangler.jsonc` for T004; root + `apps/server`
  `package.json` for T005). **T005 is the only writer of `apps/server/package.json`** (version pins),
  so keep T004 scoped to schema/env/wrangler/types to avoid an overlap.
- **Wave 1 libs:** **T009 first** (it creates the canonical `lib/crypto.ts`), then T008, T010, T011,
  T012, T013 in parallel — each owns its own `src/lib/*.ts` + test. T008/T018/T019 import `crypto.ts`
  (do not re-implement hex/sha256). T013 reads `http.ts` (T007) but does not modify it.
- **Client strand:** T015 → T016 → T017 run independently of the whole server side.
- **Wave 4:** T029, T030, T031 in parallel (distinct files); T032 serializes after them.
- **CLI:** T034, T035, T036 in parallel after T033 (distinct command files).

**Serialization points — do NOT run these concurrently (shared-file writers):**

- `apps/server/src/app.ts`: written by **T007** (shell), **T020** (mount admin routes), **T028**
  (SPA fallback), **T031** (wire onError logging). Order them T007 → T020 → T028 → T031, or have one
  agent own `app.ts` across those tasks.
- `apps/server/src/routes/stats.ts`: stub replaced by **T022** only. `routes/collect.ts`: **T014**
  only. Keep single-writer.
- `apps/server/wrangler.jsonc`: **T004** is the sole writer. T028/T037 rely on it but must not edit
  it.
- `apps/server/src/db/schema.ts` + `migrations/`: **T003** is the sole writer.
- `packages/shared/src/stats.ts`: **T001** sole writer (T027/T022 only consume the added fields).
- root `package.json`: **T005** sole writer (T041 bumps only the `version` field; sequence T005
  before T041).
- `apps/server/package.json`: **T005** (pins) and **T037** (adds `seed:local`) both write it —
  sequence T005 → T037.

**v2+ phase-level parallelism.** Each phase's migration/binding task is its serialization gate; once
it lands, that phase's libs run in parallel. Whole phases are largely independent and can run
concurrently **except** where they share the files listed below. Recommended concurrency: Phase 2 →
then Phases 3, 4, 5, 6, 8 in parallel (each behind its own migration/binding task) → Phase 7 after
the endpoints it visualizes exist → Phase 9 last (heaviest).

**v2+ serialization points (shared-file writers — never concurrent; the DRY registry patterns below
shrink these):**

- `apps/server/src/db/schema.ts` + `migrations/`: **T003 → T044 → T054 → T068 → T086 → T092** (one
  migration at a time; each is the sole writer for its `000N` file). Only **T044** changes `events`
  columns and must bump the T003 column-count guard.
- `apps/server/wrangler.jsonc`: **T004 → T062a → T076 → T086 → T092** (each promotes one binding
  block). Sole-writer sequence.
- `apps/server/src/env.ts`: same sequence as wrangler (**T004, T062a, T076, T086, T092**) — each adds
  its bindings to `Env`.
- `apps/server/src/index.ts`: **T076** (export `LiveHub`) and **T094a** (add the `queue` consumer) —
  sequence T076 → T094a.
- `apps/server/src/lib/scheduled.ts` (job registry, see DRY mandate): **T032 → T048 → T088 → T093b**
  each register one job; do not edit concurrently.
- `apps/server/src/routes/registry.ts` (route registry, see DRY mandate): every route task appends
  one line (**T007, T020, T028, T055, T058, T064, T070, T078, T096**, plus the stats sub-routers).
  Trivially mergeable but still sequence to be safe.
- `packages/shared/src/schemas.ts`: **T002 → T046 → T055 → T058 → T064 → T070 → T082 → T096** — each
  adds schemas; sequence.
- `packages/client/tsup.config.ts` + `packages/client/package.json`: **T017 → T063 → T071** (each
  adds a build entry). Sequence.
- `apps/dashboard/src/hooks/` (per-feature files, see DRY mandate) and
  `apps/dashboard/src/routes.tsx`: per-feature hook files avoid conflicts; `routes.tsx` (**T084**) is
  its sole writer and each dashboard task registers its route lazily.

### Task count & phase summary

| Phase | Range | Count | Delivers |
| --- | --- | --- | --- |
| v1 | T001–T043 | 43 | Pageviews, custom events, per-hostname uniques, top paths/referrers, geo/device, API keys, dashboard, self-host deploy |
| Phase 2 | T044–T053 | 10 | Sessions, bounce/pages/duration, traffic-source channels, UTM |
| Phase 3 | T054–T061 | 8 | Goals, form tracking, conversions, funnels |
| Phase 4 | T062a/b–T067 | 7 | Web Vitals + Navigation Timing via Analytics Engine |
| Phase 5 | T068–T075 | 8 | A/B experiments, bucketing, significance |
| Phase 6 | T076–T080 | 5 | Real-time live path (DO + hibernatable WebSockets) |
| Phase 7 | T081a/b–T085 | 6 | Interactive ECharts, global filters, drill-down, routes |
| Phase 8 | T086–T091 | 7 | Statistical anomaly detection + Workers-AI insights |
| Phase 9 | T092–T099 | 10 | Social listening: ingest → sentiment → clustering (Vectorize) |

**Total: 104 tasks** across 9 phases (43 v1 + 61 v2+). The v2+ count reflects the five split tasks
(T062, T081, T088, T093, T094 each became an `a`/`b` pair). Every task remains single-responsibility
with concrete, machine-checkable completion criteria.

---

## Testing & Quality Strategy

- **Unit tests (pure logic):** `hash`, `bots`, `request-meta`, `salt` math, client `track`, CLI
  parsing/commands, dashboard components. Run in their package's default Vitest environment
  (`node`/`jsdom`). No D1.
- **Worker integration tests (real runtime):** everything touching D1, routing, or bindings runs in
  `workerd` via `@cloudflare/vitest-pool-workers`, against a Miniflare-local D1 migrated by the
  **T006** harness (`readD1Migrations` + `applyD1Migrations` in `test/apply-migrations.ts`). Bindings
  `ADMIN_TOKEN='test-admin-token'` and `RAW_RETENTION_DAYS='90'` are provided by `vitest.config.ts`.
  The `ratelimit` binding is **not** emulated; the middleware no-ops without it and is unit-tested in
  isolation (T013).
- **Per-test D1 isolation (mandatory — prevents flaky parallel runs):** `vitest.config.ts` sets
  `poolOptions.workers.isolatedStorage: true`, so each test gets its own D1 storage stack that is
  pushed before and rolled back after the test. **No test may depend on rows written by another test,
  a fixed row count in a shared DB, or ordering between tests.** Every test seeds exactly the rows it
  asserts on (via `test/fixtures.ts`) and reads back only those. Do not disable `isolatedStorage` or
  share a global seeded database across suites; doing so reintroduces cross-test collisions.
- **Fixtures:** shared deterministic seeders in `apps/server/test/fixtures.ts` (T006); tests pass an
  explicit base timestamp so runs are reproducible (never call `Date.now()` inside a fixture).
- **Dashboard build dependency:** `apps/server` `pretest` builds `@countless/dashboard` so the
  `assets.directory` (`../dashboard/dist`) exists when pool-workers validates the wrangler config.
- **Coverage expectation:** every `src/**` module that contains logic ships with a colocated test;
  the ingest handler (T014), stats handler (T022), rollups (T029), retention (T030), auth (T019), and
  the e2e path (T043) are mandatory and must assert exact values, status codes, and bodies (not
  "works"). Aim for ≥ 90% line coverage in `apps/server/src/lib` and `src/routes`.
- **Acceptance gate:** **T043** is the single end-to-end test that must pass before tagging a release
  — client-shaped payloads → collect → D1 → scheduled rollup → stats (with per-hostname split) → asset
  serving, all with asserted aggregates.

---

## Scope boundaries (v1 vs v2+ vs never)

**Out of v1, but now scheduled in a specific v2+ phase** — do NOT pull these forward into a v1 task
(T001–T043); build them only under their phase's tasks:

- **Funnels** → Phase 3 (T058–T061).
- **A/B testing / experiments** → Phase 5 (T068–T075).
- **Anomaly detection / automated insights** → Phase 8 (T086–T091).
- **Real-time / live-updating dashboards** (WebSockets, DO live counters) → Phase 6 (T076–T080).
- **Sessions, bounce rate, traffic sources** → Phase 2 (T044–T053).
- **Conversions & form tracking** → Phase 3 (T054–T057).
- **Performance / Web Vitals** → Phase 4 (T062–T067).
- **Interactive drill-down charts** → Phase 7 (T081–T085).
- **Social listening / opinion mining** → Phase 9 (T092–T099).
- **Data export / R2 archival** — partial: R2 raw archival lands in Phase 9 (T092/T093) for social
  only. A general CSV/Parquet stats-export endpoint remains **unscheduled** (see below).

**Still deferred — in NO phase; requires a new design pass before any task exists:**

- **Session replay** (event/DOM recording, playback).
- **Retention / cohort analytics** (returning-user cohorts over time) — note this is impossible under
  the current daily-rotating hash without a privacy-model change; a design pass must resolve that
  first.
- **Alerting / notifications** (email/webhook on anomaly) — Phase 8 *detects* and surfaces insights
  in-dashboard, but does not send outbound alerts.
- **General CSV/Parquet stats-export endpoint.**
- **Choropleth geo maps** — geo stays a ranked country **list** (v1) / interactive list (Phase 7).
- **Multi-site-per-key dashboards, user accounts, RBAC, team management, billing** — auth stays
  admin-token + single-site API keys across all planned phases.

If a "still deferred" capability is genuinely needed, stop and surface it as a new-phase proposal; do
not implement it under an existing task.

---

## Post-v1 Scale Path (deferred infrastructure — do NOT build in v1)

Everything here is **100% Cloudflare-native** (no external SaaS: no Upstash/Redis, no Sentry, no
Vercel/OTel vendor). Rule of thumb: if it is not a Cloudflare binding (`d1_databases`,
`kv_namespaces`, `r2_buckets`, `durable_objects`, `queues`, `analytics_engine_datasets`, `ai`,
`vectorize`, `hyperdrive`, `workflows`), it is external and banned. These live as **commented-out**
bindings in `apps/server/wrangler.jsonc`; promote a block only in its own follow-up task after v1
ships. None are on the v1 critical path.

| Capability | Cloudflare-native mechanism | Replaces (rejected external) |
| --- | --- | --- |
| High-volume metrics | **Analytics Engine** (`writeDataPoint`) + AE-SQL over HTTP | ClickHouse / Honeycomb |
| Real-time / exact aggregation | **Durable Objects** + `alarm()` (1 DO per `metric_key:bucket`, flush to D1/AE) | — |
| Global exact rate limiting | **Durable Object** token-bucket (1 DO per ip/key) | Upstash + Redis |
| Ingest/aggregation decoupling | **Queues** (at-least-once, retries, batching) | Kafka / SQS |
| Exports & archival | **R2** (CSV/Parquet, presigned S3 URLs; nightly AE→R2) | S3 |
| In-worker OLAP | **duckdb-wasm** over Arrow IPC from AE/R2 | external OLAP |
| Error tracking | `try/catch` → D1/AE; **Tail Workers** + **Logpush → R2** | Sentry SaaS |
| Config cache | **KV** + `caches.default` (Cache API) | Redis |

**v1 rate limiting stays on the native Rate Limiting binding** (`ratelimit`) — zero external hops, no
DO/storage/alarms. The DO token-bucket is the *global-exact* upgrade, deferred.

Deferred npm packages (install only when promoting the matching capability): `apache-arrow`,
`@duckdb/duckdb-wasm`, `@aws-sdk/client-s3` (R2 S3 API), `maplibre-gl` (choropleth geo),
`echarts`/`@visx/*` (advanced charts), `framer-motion` (motion), `@tanstack/react-table` +
`@tanstack/react-virtual` (virtualized tables), `superjson` (DO→client serialization). Explicitly
still banned post-v1: `@upstash/*`, `zod`-only tooling (`@hono/zod-openapi`, `@trpc/*`), any hosted
SaaS SDK.

<!--
POST-v1 pattern — Durable Object token-bucket rate limiter (global-exact). Deferred.
Promote by: uncommenting the `durable_objects` + `migrations` blocks in wrangler.jsonc, adding this
class to src/do/rate-limiter.ts, and swapping the native-binding middleware for a DO call.

export class RateLimiter implements DurableObject {
  private requests: number[] = [];
  constructor(private state: DurableObjectState, private env: Env) {
    // REQUIRED: rehydrate the window after hibernation, else it resets to empty and under-counts.
    this.state.blockConcurrencyWhile(async () => {
      this.requests = (await this.state.storage.get<number[]>('requests')) ?? [];
    });
  }
  async fetch(req: Request): Promise<Response> {
    const { limit = 60, window = 60_000 } = await req.json();
    const now = Date.now();
    this.requests = this.requests.filter((t) => now - t < window);
    if (this.requests.length >= limit) {
      return new Response('rate_limited', { status: 429, headers: { 'Retry-After': '60' } });
    }
    this.requests.push(now);
    await this.state.storage.put('requests', this.requests);
    return new Response('ok');
  }
}

POST-v1 pattern — Analytics Engine ingest write (parallel to / replacing the D1 events insert):

  env.AE.writeDataPoint({
    blobs: [siteId, hostname, path, referrer, country ?? '', device, name ?? 'pageview'],
    doubles: [1],
    indexes: [visitorHash], // sampling index
  });
-->

**v1 remains: D1 + native Rate Limiting binding + Cron Triggers + static assets. Nothing above ships
in v1.**