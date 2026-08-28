<!-- API reference: ingest beacon + stats + admin endpoints. -->

# API reference

All endpoints live under `/api` on your deployment. Times are unix epoch **milliseconds**.

## Authentication

- `POST /api/collect` — **public**, no auth (CORS-open, rate-limited).
- `POST /api/event` — **API key**: first-party server-to-server ingest (`Authorization: Bearer <clk_...>`).
- `GET /api/experiments/active` — **public**: client-facing experiment config.
- `GET /api/flags/active` — **public**: cacheable feature-flag bucketing config (no targeting rules).
- `POST /api/flags/eval` — **public**, rate-limited: server-side flag evaluation (GPC-aware).
- `POST`/`DELETE /api/consent` — **API key**, rate-limited: record/revoke a visitor's consent to raise
  their identity tier (GPC-aware; `site_id` is taken from the key, never the body).
- `GET /api/stats/anomalies`, `GET /api/stats/experiments`, `GET /api/stats/experiment`,
  `GET /api/stats/retention`, `POST /api/stats/query` — **API key**.
- `GET /api/stats`, `GET /api/stats/cube`, `GET /api/stats/sessions`, `GET /api/stats/channels`,
  `GET /api/stats/interactions`, `GET /api/stats/realtime`, `GET /api/stats/export`,
  `GET /api/stats/conversions`, `GET /api/stats/goals`, `GET /api/stats/funnels`,
  `GET /api/funnels/:id/report` — **API key**: `Authorization: Bearer <clk_...>`
  (site-scoped; a key that does not own the requested `site_id` gets `403 site_mismatch`).
- `POST /api/sites`, `GET /api/sites`, `POST /api/keys`, `GET /api/keys`,
  `DELETE /api/keys/:id`, goal/funnel CRUD (`POST`/`GET`/`DELETE /api/goals`,
  `POST`/`GET`/`DELETE /api/funnels`), identity config (`PATCH /api/sites/:id/identity`),
  flag CRUD (`POST`/`GET /api/flags`, `PATCH`/`DELETE /api/flags/:id`), alert destinations
  (`POST`/`GET /api/alerts`, `DELETE /api/alerts/:id`) and metric alert rules
  (`POST`/`GET /api/alerts/rules`, `DELETE /api/alerts/rules/:id`), historical import (`POST /api/import`),
  and `POST /api/auth/admin-link` —
  **admin token**: `Authorization: Bearer <ADMIN_TOKEN>`.
- `POST /api/auth/request`, `POST /api/auth/verify` — **public**, rate-limited (dashboard sign-in);
  `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/logout-everywhere` — **session
  cookie**. All `503 auth_unavailable`
  unless `SESSION_SECRET` is bound.
- `/api/crm/*` — **session cookie + team role**, and deliberately *not* an API key. This is the only
  authenticated surface that refuses `clk_` keys: they authorize aggregate analytics and are meant to
  be handed out, which contact PII does not survive. `501 crm_unavailable` unless `CRM_DB` is bound.

## Error envelope

Every error returns the canonical body:

```json
{ "error": "<code>", "message": "optional detail", "issues": [ "optional validation detail" ] }
```

`message` is omitted when it would only echo the code; `issues` appears only for
validation failures. The full set of codes:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `validation_failed` | 400 | Request body / query failed schema validation (see `issues`); also malformed JSON. |
| `bad_request` | 400 | Missing required parameter (e.g. `site_id` query on key routes). |
| `bad_range` | 400 | Stats `end` is not strictly greater than `start`. |
| `range_too_large` | 400 | Stats range exceeds the 90-day maximum. |
| `payload_too_large` | 413 | Collect body exceeded 8192 bytes. |
| `invalid_api_key` | 401 | Missing or unrecognized stats API key. |
| `invalid_admin_token` | 401 | Missing or incorrect admin token. |
| `site_mismatch` | 403 | Stats API key does not own the requested `site_id`. |
| `not_found` | 404 | Unknown `/api/*` route, or key id not found on delete. |
| `rate_limited` | 429 | Rate limit exceeded (`Retry-After: 60`). |
| `internal_error` | 500 | Unexpected server error (details never leaked to the client). |

---

## `GET /api/ready`

Authenticated deployment-readiness check. Send `Authorization: Bearer <ADMIN_TOKEN>`. It verifies
D1 connectivity and reports whether the required rate limiter, admin token, and retention setting
are present; the optional ingest queue is reported separately. Returns `200` when required checks
pass, `503` when the deployment is not ready, and `401` without valid admin authentication.

---

## `POST /api/collect`

Public ingest beacon. CORS allows any origin (`POST` / `OPTIONS`, `content-type` header,
preflight cached 24h). Rate-limited by client IP. Request bodies over **8192 bytes** are
rejected with `413 payload_too_large` before parsing. Bot user-agents are silently dropped
(the request still returns `202` but no event is written). On success, returns **`202`**
with an empty body.

By default, collection also verifies that `site_id` exists, that `hostname` belongs to the site's
configured domain, and that a browser `Origin` agrees with that hostname. Invalid targets are
silently dropped with the same `202` response so the endpoint cannot enumerate site ids.
`COLLECT_VALIDATE_SITE=false` is intended only for isolated tests or legacy compatibility.

A request carrying the [Global Privacy Control](https://globalprivacycontrol.org/) header
`Sec-GPC: 1` is **still counted**: the event is written and the anonymous, cookieless pageview
is included in total traffic, because it carries no personal data. What GPC does instead is
force the anonymous Tier-0 visitor hash for that request, so a signalling visitor can never be
identity-elevated whatever consent record exists (`apps/server/src/lib/ingest.ts`). It also
disables personalization — feature-flag evaluation returns `reason: "gpc"` and experiments are
never bucketed. Only a **deliberate** client opt-out (`localStorage['facet.optout']` or
`data-facet-optout`) suppresses the beacon, and that happens in the browser: no request is
sent at all.

Body fields (`site_id`, `hostname`, `path`, `referrer` required; `name`, `props`
optional):

| Field | Type | Constraints |
| --- | --- | --- |
| `site_id` | string | UUID |
| `hostname` | string | 1–253 chars |
| `path` | string | 1–2048 chars, must start with `/` |
| `referrer` | string | ≤ 2048 chars (may be empty) |
| `name` | string | optional; 1–128 chars (omit for a pageview) |
| `props` | object | optional; ≤ 24 keys, keys 1–40 chars, values string ≤ 500 / finite number / boolean / null |
| `utm` | object | optional; `{ source?, medium?, campaign? }`, each a string ≤ 200 chars. Captured automatically by the client from `utm_*` query params; drives [traffic-channel](#traffic-channels) classification. |

**Example request:**

```sh
curl -X POST https://your-deployment.example.com/api/collect \
  -H "content-type: application/json" \
  -d '{
    "site_id": "11111111-1111-4111-8111-111111111111",
    "hostname": "example.com",
    "path": "/pricing",
    "referrer": "https://google.com/",
    "name": "signup",
    "props": { "plan": "pro" }
  }'
```

**Example response:** `202 Accepted`, empty body.

A validation failure returns:

```json
{ "error": "validation_failed", "issues": [ /* valibot issues */ ] }
```

---

## `POST /api/event`

First-party **server-to-server** event ingest, authenticated with an API key. Send events from
your own backend so ad-blockers and content filters can't drop client-side traffic — because the
request originates from your first-party server, there is no third-party script to block. Same
privacy model as the beacon: any supplied `ip` is used only to derive the daily visitor hash and is
never stored.

- **Auth:** `Authorization: Bearer <api_key>` (the site is taken from the key; no `site_id` in the body).
- **Body:** `hostname`, `path` (absolute), optional `referrer`, `name`, `props`, `utm`, and optional
  `ip` / `user_agent` (the end-user's, for hashing + device/channel classification).
- **Responses:** `202` (empty) on accept or bot-drop; `400 validation_failed`; `401 invalid_api_key`.
- A relayed `Sec-GPC: 1` does not drop the event (same rule as the beacon above): it is counted,
  pinned to the anonymous Tier-0 hash, and any supplied `user_id` is ignored.

```sh
curl -X POST https://your-deployment.example.com/api/event \
  -H "Authorization: Bearer clk_..." \
  -H "content-type: application/json" \
  -d '{"hostname":"shop.example.com","path":"/checkout","name":"purchase",
       "props":{"amount":42},"ip":"203.0.113.9","user_agent":"Mozilla/5.0 ..."}'
```

---

## `POST /api/import`

Admin token. Backfills event-level history exported from another analytics tool. This is deliberately
**not** a timestamp field on `POST /api/event`: backdating rewrites history, so it is gated on the
admin token rather than on a write-scoped API key.

```json
{
  "site_id": "<uuid>",
  "dry_run": false,
  "events": [
    {
      "timestamp": 1767225600000,
      "visitor_id": "the-source-tool-s-own-visitor-id",
      "hostname": "legacy.example.com",
      "path": "/pricing",
      "referrer": "https://news.ycombinator.com/",
      "name": "signup",
      "props": { "plan": "pro" },
      "utm": { "source": "hn" },
      "country": "US",
      "user_agent": "Mozilla/5.0 ..."
    }
  ]
}
```

`timestamp` is unix epoch **milliseconds**. `visitor_id` is required and is the source tool's own
opaque visitor identifier: it is hashed under an `import:` pre-image with that UTC day's salt and is
never stored, so imported history cannot be linked back to a person, to a live visitor's hash, or
across days. Rows are not mirrored to Analytics Engine (which cannot backdate a data point).

Bounds, all enforced per request: at most **500 events** spanning at most **31 distinct UTC days**.
A batch reaching before `RAW_RETENTION_DAYS` is rejected with `400 out_of_retention` rather than
written and deleted by the next retention run; a future timestamp is rejected with
`400 future_timestamp`; an unknown `site_id` is `404 site_not_found`. Event ids are derived from row
content, so re-running an import that partially succeeded is a no-op, not a duplicate.

```json
{
  "imported": 4,
  "skipped": 0,
  "duplicates": 0,
  "days": ["2026-08-20"],
  "note": "Imported visitors are hashed under the destination site's per-day salt, ..."
}
```

`skipped` counts rows dropped by the bot filter (applied only to rows that carried a `user_agent`);
`duplicates` counts rows that collapsed onto an id already in the same batch.
Daily rollups and sessions are rebuilt for every imported day; hourly rollups are not backfilled.

## `GET /api/stats`

Returns aggregated stats for one site. Requires a stats API key that owns `site_id`.

**Query parameters:**

| Param | Required | Notes |
| --- | --- | --- |
| `site_id` | yes | UUID; the key must own it or you get `403 site_mismatch`. |
| `start` | yes | Inclusive range start, unix ms. |
| `end` | yes | Exclusive range end, unix ms. Must be `> start` (else `400 bad_range`). Range ≤ 90 days (else `400 range_too_large`). |
| `hostname` | no | Optional hostname filter. |
| `interval` | no | `hour` or `day`. Defaults to `hour` when the range ≤ 48h, otherwise `day`. |

**Example request:**

```sh
curl "https://your-deployment.example.com/api/stats?site_id=11111111-1111-4111-8111-111111111111&start=1704067200000&end=1704672000000&interval=day" \
  -H "Authorization: Bearer clk_localdevkey"
```

**Example response** (`200`) — the `StatsResponse` body. `series` is zero-filled across
every bucket; the `top_*` lists are `{ key, count }` rows sorted by count descending (top
10 each for paths/referrers/events/countries; devices unbounded). `engagement` and
`channels` are described under [Sessions & engagement](#sessions--engagement) and
[Traffic channels](#traffic-channels) below:

```json
{
  "summary": { "pageviews": 24, "visitors": 15, "events": 6 },
  "series": [
    { "t": 1704067200000, "pageviews": 4, "visitors": 3 },
    { "t": 1704153600000, "pageviews": 5, "visitors": 4 }
  ],
  "top_paths": [
    { "key": "/", "count": 14 },
    { "key": "/pricing", "count": 6 }
  ],
  "top_referrers": [
    { "key": "https://google.com/", "count": 2 }
  ],
  "top_events": [
    { "key": "signup", "count": 4 }
  ],
  "top_countries": [
    { "key": "US", "count": 16 },
    { "key": "DE", "count": 14 }
  ],
  "top_devices": [
    { "key": "desktop", "count": 16 },
    { "key": "mobile", "count": 14 }
  ],
  "engagement": {
    "sessions": 12,
    "bounce_rate": 0.42,
    "pages_per_session": 2.1,
    "avg_duration_ms": 48200
  },
  "channels": [
    { "key": "organic", "count": 8 },
    { "key": "direct", "count": 4 }
  ],
  "meta": { "materialization": "hourly", "pending": false }
}
```

- `summary.pageviews` counts events with no `name`; `summary.events` counts named events;
  `summary.visitors` is `COUNT(DISTINCT visitor_hash)` over the range (see the
  [privacy model](./privacy.md) for daily-uniques semantics).
- `summary.events` and `top_events` count **marketer-facing custom events only**;
  internal/system interactions (`$exposure`, `form_submit`, and any other `$`-prefixed name)
  are excluded and surfaced separately at [`GET /api/stats/interactions`](#get-apistatsinteractionssite_idstartend-api-key).
- `meta` is a **backward-compatible** freshness signal for session-derived analytics
  (`engagement`, `channels`, and the `/sessions` and `/channels` endpoints). Those are
  materialized from raw events by an hourly cron, so `meta.materialization` is always
  `"hourly"`, and `meta.pending` is `true` when raw events exist in the range but no sessions
  have been materialized yet (the cron has not caught up) — letting a caller distinguish
  "no data" from "not built yet". `GET /api/stats/sessions` and `GET /api/stats/channels`
  return the same `meta` block.

---

### `GET /api/stats/cube?site_id&start&end&interval=hour|day` (API key)

The low-cardinality dimensional cube for the range: one cell per `(bucket, device, country,
channel)` with `pageviews` / `events` / `visitors`. The dashboard hydrates this once and slices
by those axes client-side with no further round-trips. Same query schema, site-ownership check
and range cap as `GET /api/stats`; `interval` defaults the same way.

Country is folded to the top 30 by volume plus `'other'`, so the cube is bounded **and**
complete — every event lands in a cell and the totals still reconcile with `GET /api/stats`.
`path` and `referrer` are deliberately excluded (high cardinality; use the breakdowns).

```json
{
  "interval": "day",
  "cells": [
    { "t": 1730000000000, "device": "desktop", "country": "US", "channel": "organic",
      "pageviews": 42, "events": 3, "visitors": 20 }
  ]
}
```

---

### `GET /api/stats/breakdown?site_id&start&end&dimension=&limit=` (API key)

Group the range by **one** dimension. This is the only read that reaches the columns Facet stores
but no other endpoint surfaces — `city`, `timezone`, `utm_source`, `utm_medium`, `utm_campaign`,
`form_factor`, `currency`, `hostname` — and it accepts the same `path` / `referrer` / `country` /
`device` / `channel` filters as `GET /api/stats`.

`dimension` is required and must be one of: `hostname`, `path`, `referrer`, `event`, `country`,
`region`, `city`, `timezone`, `network`, `language`, `device`, `form_factor`, `browser`, `os`,
`channel`, `utm_source`, `utm_medium`, `utm_campaign`, `currency`. Anything else is
`400 validation_failed`. `limit` is `1..200` (default 25).

Every group must clear a **k-anonymity floor of 3 distinct visitors** to appear at all, so a
breakdown can never resolve to one person's browsing. An absent dimension value is reported as the
empty string, never as `null`. `dimension=event` is the raw `name` column, so it includes the
internal `$`-prefixed events and `form_submit` that `top_events` on `GET /api/stats` filters out —
use `top_events` / `GET /api/stats/interactions` when you want that split.

```json
{
  "dimension": "city",
  "source": "d1",
  "sampled": false,
  "rows": [{ "key": "Berlin", "events": 412, "pageviews": 380, "visitors": 96 }]
}
```

`source` says which store answered. A deployment with Analytics Engine configured
(`AE_BEST_EFFORT_ENABLED=true`, `analytics_engine_datasets` bound, plus the `CF_ACCOUNT_ID` var and `CF_API_TOKEN` secret) is
served from the columnar mirror; every other deployment — and any query the mirror cannot express —
falls back to D1, which is always exact. **When `sampled` is `true` the figures are estimates:**
Analytics Engine samples under load, `events` and `pageviews` are sampling-corrected, and `visitors`
is a distinct count that no sampling weight can correct, so it is a lower bound. `source: "d1"` is
always exact and always `"sampled": false`.

---

## Visualization reads

Five shapes the cube and the flat top-N lists cannot express: a session distribution
(box/violin), a per-dimension time series (multi-line), the URL-prefix tree (treemap and
sunburst), entry→exit journeys (chord/Sankey), and the UTC clock grid (nightingale, day×hour
heatmap).

All five are **API key** authenticated (`Authorization: Bearer <clk_...>`), site-scoped (a key
that does not own `site_id` gets `403 site_mismatch`), and enforce the same range rules as
`GET /api/stats` (`end > start` else `400 bad_range`; range ≤ 90 days else
`400 range_too_large`). Every response is bounded by a constant, never by the data: a site with a
million distinct URLs and a site with ten get the same maximum response size.

### `GET /api/stats/distribution` (API key)

Session **duration** and **pages-per-session** as summary statistics plus a bounded histogram.
Raw per-session rows are never returned — they are unbounded, and each one is a single visitor's
behaviour.

Same query parameters as `GET /api/stats`, with one restriction: only `channel` may be used as a
filter. `hostname`, `path`, `referrer`, `country` and `device` return `400 unsupported_filter`,
because `event_sessions` is a materialized per-session row with no such column — and answering
them by *ignoring* them would return the unfiltered distribution under a filtered label.

`percentiles[p]` is the value at 0-based index `floor(p × (n − 1))` of the ascending sample — the
**nearest-rank-lower** order statistic, **not** an interpolated quartile. It is therefore always a
value some session actually had. A renderer wanting interpolated quartiles must interpolate itself.

`histogram` bins are `[from, to)` and partition the metric's whole domain (the last bin is
open-ended, `to: null`), so the bin counts always sum to `count`.

**Privacy:** statistics are emitted only once at least `min_count` (**25**) sessions match. That
floor is higher than the k-anonymity floor used for breakdowns (3) on purpose: a distribution
reports eleven order statistics, so below ~11 observations the percentile vector *is* the raw
sample re-encoded. Below the floor, `suppressed` is `true` and both distributions are `null`.

Duration bins are `1s / 5s / 15s / 30s / 1m / 2m / 5m / 10m / 30m` and above; pageview bins are
`0`, one each for `1`–`5`, then `6–10`, `11–20`, `21+`.

---

### `GET /api/stats/timeseries` (API key)

One time series per top-N dimension value, for a multi-line chart. The cube already answers this
client-side for `device` / `country` / `channel`; the gap this closes is `path` and `referrer`,
which are deliberately excluded from the cube.

| Param | Required | Notes |
| --- | --- | --- |
| `dimension` | yes | `path`, `referrer`, `country`, `device` or `channel`. No default — guessing one would answer a different question than the caller asked. |
| `limit` | no | Lines to return, `1`–`8` (default `5`). Outside that range is `400 validation_failed`, not a silent clamp. |

Plus every parameter `GET /api/stats` accepts (`site_id`, `start`, `end`, `interval`, `hostname`,
and the exact-match dimension filters).

There is **no `visitors` field, deliberately.** `COUNT(DISTINCT visitor_hash)` per (key, bucket) is
not additive along either axis: a visitor who reads two paths in one hour is counted on both lines,
and a visitor active in two hours is counted in both buckets. A multi-line chart invites exactly
that summation, so a visitors field here would be wrong in the chart's most common reading.
`pageviews` and `events` are plain counts and are additive in both directions.

Keys are ranked by **pageviews over the whole range**, which is not identical to the `top_paths`
ordering on `GET /api/stats` (that counts every event on a path). `series` covers only the top
`limit` keys, so the lines do **not** sum to the range total; `truncated` says whether a tail was
dropped. Each line is zero-filled across every bucket in the range.

**Privacy:** a key must clear the k-anonymity floor (3 events over the range) before it becomes a
labelled line. Beyond that, this endpoint batches calls that
`GET /api/stats?path=…&interval=hour` already answers one at a time — it adds no resolution.

---

### `GET /api/stats/path-tree` (API key)

The URL-prefix tree for a zoomable treemap or a sunburst: `/blog/post-a` and `/blog/post-b` roll up
under `/blog`. Same query parameters as `GET /api/stats`.

`pageviews` on a node is the **subtree** total (what a treemap's area encodes); `self` is the
pageviews on that exact path, so `pageviews - self` is what the children hold. Counts are
**pageviews** (beacons with no event name), so the root reconciles with `summary.pageviews` — not
with `top_paths`, which counts every event on a path.

The tree stops at `max_depth` (**4**); a deeper URL contributes to its ancestor at that depth. Each
node keeps at most 12 labelled children. Query strings and duplicate slashes are normalized away,
so `/blog//post-a/` and `/blog/post-a?utm_source=x` land on the same node.

**Privacy:** a URL path is attacker-controlled text that can carry an identifier a site
accidentally put in its own routes. Any subtree below `min_count` (**3**) pageviews is folded into
its parent's synthetic `other` node (`"other": true`) rather than being labelled — strictly
stronger than `top_paths`, which surfaces a one-hit path verbatim. Folding preserves the totals, so
children always sum to their parent's subtree total and nothing vanishes from the chart.

---

### `GET /api/stats/journeys` (API key)

The most-travelled entry→exit journeys over the range, from the materialized session rows — the
input for a chord diagram or a second Sankey. Same query parameters as `GET /api/stats`. Capped at
50 pairs. `entry === exit` is a real single-page journey (a bounce), not a placeholder.

**Privacy:** an (entry, exit) pair is a two-step behavioural sequence for one visit, over two
attacker-supplied URLs — the most re-identifying shape in the API. A pair is therefore surfaced only
once at least `min_visitors` (**3**) **distinct visitors** took it, not merely three sessions: one
person reloading a rare page three times must not clear the floor. `sessions` counts only the
returned pairs, so `total_sessions - sessions` is what the floor and the 50-pair bound withheld.

Sessions are materialized by an hourly cron, so `meta` carries the same freshness signal as
`GET /api/stats/sessions`.

---

### `GET /api/stats/clock` (API key)

Activity folded onto a 7 × 24 grid, for a polar/nightingale chart and a day×hour heatmap. Same
query parameters as `GET /api/stats`, including every dimension filter.

**Everything is UTC, always.** `day` is `0` = Sunday … `6` = Saturday and `hour` is `0`–`23`, both
derived from `events.created_at` by integer arithmetic on the unix epoch — no site timezone, no
server locale, no `strftime` modifier. A dashboard that wants local hours must shift these
client-side; the server will not guess a timezone it was never told.

`cells` is always exactly 168 entries, zero-filled and ordered day-major, so a heatmap can index it
as `cells[day * 24 + hour]`. `by_hour` and `by_day` are the pageview marginals (24 and 7 entries).
The response size is fixed whatever the range.

**Privacy:** no anonymity floor is applied, because this is strictly coarser than
`GET /api/stats?interval=hour`, which already returns exact per-hour counts. Collapsing every date
in the range onto one weekly grid can only blur timestamps, never sharpen them.

---

## Sessions & engagement

Sessions are derived server-side from raw events, never sent by the client. Events for a
given `(site, visitor)` are folded into a session; a new session starts whenever the gap
between two adjacent events exceeds **30 minutes** (`SESSION_TIMEOUT_MS`), and sessions are
built per UTC day. Each session carries a non-reversible `SHA-256` id, entry/exit path,
duration, pageview/event counts, and a bounce flag (a session with ≤ 1 pageview). Sessions
carry **no raw IP or user-agent**; see the [privacy model](./privacy.md#sessions--utm).

Engagement metrics are the aggregate over sessions whose `started_at` falls in the range:

| Field | Type | Meaning |
| --- | --- | --- |
| `sessions` | number | Count of sessions in range. |
| `bounce_rate` | number | Fraction of sessions with ≤ 1 pageview (0–1). |
| `pages_per_session` | number | Mean pageviews per session. |
| `avg_duration_ms` | number | Mean session duration in milliseconds. |

### `GET /api/stats/sessions`

Returns just the engagement block. **API key**: `Authorization: Bearer <clk_...>`. Same
query parameters as `GET /api/stats` (`site_id` required and key-owned; `start`, `end`;
optional `hostname`). Returns `403 site_mismatch` if the key does not own the site.

```sh
curl "https://your-deployment.example.com/api/stats/sessions?site_id=11111111-1111-4111-8111-111111111111&start=1704067200000&end=1704672000000" \
  -H "Authorization: Bearer clk_localdevkey"
```

```json
{
  "engagement": {
    "sessions": 12,
    "bounce_rate": 0.42,
    "pages_per_session": 2.1,
    "avg_duration_ms": 48200
  },
  "meta": { "materialization": "hourly", "pending": false }
}
```

---

## Traffic channels

Each event is classified into exactly one channel from its UTM tags + referrer + the site
hostname, in this precedence order: **paid** (utm_medium ∈ cpc/ppc/paid/paidsearch/display) →
**email** (utm_medium `email` or utm_source `newsletter`) → **social** (utm_medium `social`
or a known social referrer host) → **organic** (search-engine referrer host) → **direct**
(no referrer) → **internal** (referrer host equals the site hostname) → **referral**
(any other referrer). Channel counts are `{ key, count }` rows.

### `GET /api/stats/channels`

**API key**: `Authorization: Bearer <clk_...>`. Same query parameters as `GET /api/stats`
(`site_id` required and key-owned; `start`, `end`; optional `hostname`).

```sh
curl "https://your-deployment.example.com/api/stats/channels?site_id=11111111-1111-4111-8111-111111111111&start=1704067200000&end=1704672000000" \
  -H "Authorization: Bearer clk_localdevkey"
```

```json
{
  "channels": [
    { "key": "organic", "count": 8 },
    { "key": "direct", "count": 4 },
    { "key": "referral", "count": 2 }
  ],
  "meta": { "materialization": "hourly", "pending": false }
}
```

---

## Interactions, realtime & export

These reads are all **API key** authenticated (`Authorization: Bearer <clk_...>`),
site-scoped (a key that does not own `site_id` gets `403 site_mismatch`), and — where a range
applies — enforce the same `bad_range` / `range_too_large` rules as `GET /api/stats`
(`end > start`, range ≤ 90 days).

### `GET /api/stats/interactions?site_id&start&end` (API key)

Internal/system interactions counted separately from marketer-facing custom events.
`$exposure` (experiment exposure), `form_submit`, and any other `$`-prefixed event name are
**excluded** from `top_events` and the custom-events KPI and reported here instead. Returns
`{ key, count }` rows sorted by count descending.

```sh
curl "https://your-deployment.example.com/api/stats/interactions?site_id=11111111-1111-4111-8111-111111111111&start=1704067200000&end=1704672000000" \
  -H "Authorization: Bearer clk_localdevkey"
```

```json
{
  "interactions": [
    { "key": "$exposure", "count": 210 },
    { "key": "form_submit", "count": 34 }
  ]
}
```

### `GET /api/stats/realtime?site_id` (API key)

Active-visitor snapshot over a fixed trailing **5-minute** window (`window_ms` is `300000`).
`visitors` is the count of distinct **daily visitor hashes** seen in the window — a
privacy-safe proxy for "active visitors" with **no cookies and no persistent id**. It is an
**approximation**: a visitor is de-duplicated only within the window (and within the current
UTC day, after which the salt rotates). `until` is the "as of" time (unix ms). Only `site_id`
is required; there is no range.

```sh
curl "https://your-deployment.example.com/api/stats/realtime?site_id=11111111-1111-4111-8111-111111111111" \
  -H "Authorization: Bearer clk_localdevkey"
```

```json
{ "window_ms": 300000, "visitors": 7, "pageviews": 12, "until": 1704672000000 }
```

### `GET /api/stats/export?site_id&start&end&kind=series|breakdown&dimension=&format=csv|json&interval=&limit=` (API key)

Read-only export of a time series or a top-N breakdown as CSV or JSON. Output is bounded
(series by range, breakdown by `limit`) and CSV cells are **formula-injection-safe** (a cell
beginning with `=`, `+`, `-`, `@`, tab, or CR is prefixed with a single quote so a spreadsheet
renders it as literal text).

| Param | Required | Notes |
| --- | --- | --- |
| `site_id` | yes | UUID; key-owned (else `403 site_mismatch`). |
| `start` | yes | Inclusive range start, unix ms. |
| `end` | yes | Exclusive range end, unix ms. `> start` (else `400 bad_range`); range ≤ 90 days (else `400 range_too_large`). |
| `kind` | no | `series` (default) or `breakdown`. |
| `dimension` | for `breakdown` | One of `path`, `referrer`, `country`, `device`, `event`, `channel`. |
| `format` | no | `csv` (default) or `json`. |
| `interval` | no | `hour` or `day` (series only). Defaults to `hour` when range ≤ 48h, otherwise `day`. |
| `limit` | no | Breakdown row cap, `1`–`1000` (default `100`). |
| `sign` | no | `1` returns a self-contained **signed-export envelope** (see below). Requires a configured signing key (`501 signing_unavailable` otherwise). |

For `kind=series` the columns are `bucket_start_iso,bucket_start_ms,pageviews,visitors`; for
`kind=breakdown` they are `key,count`. A CSV response is served with
`Content-Disposition: attachment` (e.g. `filename="facet-series-<start>-<end>.csv"`); a JSON
response is `{ "columns": [...], "rows": [...] }`.

```sh
# CSV time series (downloads as an attachment)
curl "https://your-deployment.example.com/api/stats/export?site_id=11111111-1111-4111-8111-111111111111&start=1704067200000&end=1704672000000&kind=series&interval=day&format=csv" \
  -H "Authorization: Bearer clk_localdevkey"

# JSON breakdown of top paths
curl "https://your-deployment.example.com/api/stats/export?site_id=11111111-1111-4111-8111-111111111111&start=1704067200000&end=1704672000000&kind=breakdown&dimension=path&format=json&limit=50" \
  -H "Authorization: Bearer clk_localdevkey"
```

```json
{
  "columns": ["key", "count"],
  "rows": [
    ["/", 14],
    ["/pricing", 6]
  ]
}
```

#### Signed exports (optional)

When the deployment is configured with a signing key (the `FACET_SIGNING_JWK` Worker secret,
Ed25519 preferred), the export is cryptographically verifiable. The verification key is published
at [`/.well-known/jwks.json`](#well-known-documents) and referenced by the deployment DID.

Every (unsigned-envelope) export response additionally carries integrity headers over the exact
response bytes — offered in **two** interoperable forms:

- **Detached JWS** (RFC 7515): `Facet-Signature-Jws: <protected>..<signature>` plus
  `Facet-Signing-Key: <jwks-url>`.
- **HTTP Message Signatures** (RFC 9421): `Content-Digest` (RFC 9530, SHA-256), `Signature-Input`,
  and `Signature` (covering `content-digest` and `content-type`; `ed25519` or `ecdsa-p256-sha256`).

With `sign=1` the endpoint instead returns a **self-contained JSON envelope** that verifies fully
offline — it embeds the detached JWS over the canonical (RFC 8785 JCS) payload and the public JWK:

```json
{
  "facet": "facet-signed-export/1",
  "payload": { "columns": ["key", "count"], "rows": [["/", 14]] },
  "proof": {
    "type": "DetachedJWS",
    "alg": "EdDSA",
    "kid": "<jwk-thumbprint>",
    "jws": "<protected>..<signature>",
    "publicJwk": { "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "…" },
    "jwksUrl": "https://your-deployment.example.com/.well-known/jwks.json",
    "created": "2026-07-17T00:00:00.000Z"
  }
}
```

Verify offline with the CLI: `facet verify export export.json`.

None of these signing features create any per-visitor identifier — they attest the **dataset**
(the aggregate rollups in the export), never a person.

---

## Machine readers (LLM agents)

Three endpoints exist so an agent managing a site can read its analytics cheaply, instead of
ingesting the full JSON API on every turn.

### `GET /llms.txt` (public)

A plain-text map of the deployment following the `llms.txt` convention: what this service is, how to
authenticate, which endpoint to start with, and the cookieless caveats needed to interpret the
numbers correctly. Exposes no site identifiers and no data.

### `GET /api/stats/digest?site_id&start&end` (API key)

The whole site as one **`text/markdown`** block: headline traffic with period-over-period deltas,
engagement, the top pages / referrers / countries / devices / channels, and any detected anomalies.

Markdown rather than JSON because the binding constraint for this consumer is tokens, not
parseability: a markdown table names each column once, where JSON repeats every key on every row and
XML (so RSS/Atom) adds an opening and closing tag per field on top of that. It is deliberately not a
feed — RSS models discrete chronological items with a title, link, guid and pubDate, and analytics
aggregates have none of those.

Same authentication, site-ownership check and 90-day range cap as `GET /api/stats`.

```sh
curl "https://your-deployment.example.com/api/stats/digest?site_id=$SITE_ID&start=$START&end=$END" \
  -H "Authorization: Bearer $FACET_API_KEY"
```

### `POST /api/mcp` (API key)

A [Model Context Protocol](https://modelcontextprotocol.io) endpoint over JSON-RPC 2.0, so an agent
can call tools instead of fetching documents. Implements the core surface — `initialize`,
`tools/list`, `tools/call`, `ping` — and is a deliberate subset: no resources, prompts, sampling or
SSE streaming, one request/response per POST.

Tools: `get_digest`, `get_summary`, `top_dimension`, `get_realtime`.

`top_dimension` is backed by the same code path as `GET /api/stats/breakdown`, so it groups by any
of that endpoint's dimensions — including the long-tail ones no other tool reaches (`city`,
`timezone`, `network`, `language`, `form_factor`, `utm_source`, `utm_medium`, `utm_campaign`,
`currency`) — and inherits its two properties: every group is k-anonymised on 3 distinct visitors,
and the first line of the result names which store answered (`source: d1` or
`source: analytics_engine`, the latter marked `SAMPLED` when the columnar store sampled, which makes
every count an estimate and `visitors` a lower bound). Rows are
`key`/`events`/`pageviews`/`visitors`, tab-separated; an absent dimension value is reported as
`(unset)`.

Authentication is the **bearer API key only**. The dashboard session cookie is deliberately not
accepted here: honouring a cookie on a cross-origin POST would make this a CSRF sink. Because a key
is bound to one site, no tool takes a `site_id` and no caller can reach another site's data.

A malformed request returns a JSON-RPC `error`; a tool that runs and fails returns a normal `result`
with `isError: true`, so a client can distinguish "your request was wrong" from "the query failed".

```sh
curl -X POST https://your-deployment.example.com/api/mcp \
  -H "Authorization: Bearer $FACET_API_KEY" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"get_digest","arguments":{"days":7}}}'
```

## Well-known documents

Facet serves these documents directly from the Worker (not the static-asset binding), each with the
correct content type:

| Path | Purpose |
| --- | --- |
| `/.well-known/security.txt` | RFC 9116 disclosure contact (Contact, Expires, Canonical, and Policy if you set one). `404` until you set `FACET_SECURITY_CONTACT` — Facet never publishes a contact you did not choose. |
| `/.well-known/jwks.json` | The deployment's public signing key(s) as a JWK Set. Empty (`{"keys":[]}`) when signing is unconfigured. |
| `/.well-known/did.json` | did:web DID document (`did:web:<host>`); Multikey verification method from the JWKS key. `404` unless an Ed25519 key is configured, or if the host cannot be a `did:web` (see below). |
| `/.well-known/did-configuration.json` | DIF Domain Linkage Credential binding the origin to the DID (same `404` conditions). |
| `/.well-known/facet-privacy.json` | Machine-readable privacy manifest with W3C DPV (`https://w3id.org/dpv#`) claims + deployment properties. Always available. |

These endpoints are public and unauthenticated.

The deployment DID is derived from the request host. did:web forbids an IP address there and the DID
syntax cannot express an IPv6 literal's brackets, so a deployment reached at an address rather than a
name has no DID — the two documents above `404`, and every endpoint that would sign that DID into a
credential (`/api/attestation/privacy`, `/api/scitt/attestation`, `/api/stats/report`, `/api/consent`)
returns `501 did_unavailable` instead of issuing one no verifier could resolve. Serve on a domain name.

## Verifiable credentials

When an Ed25519 signing key is configured, the deployment issues W3C VC 2.0 credentials signed with
the `eddsa-jcs-2022` Data Integrity cryptosuite, verifiable against `/.well-known/jwks.json` or the
DID. Neither credential describes a person — they attest the deployment and the aggregate dataset.

| Endpoint | Auth | Credential |
| --- | --- | --- |
| `GET /api/attestation/privacy` | public | `PrivacyAttestationCredential` — deployment build id, commit, D1 schema hash, retention days, privacy model, and DPV claims. |
| `GET /api/stats/report?site_id&start&end` | API key | `AnalyticsReportCredential` — an aggregate stats snapshot (pageviews/visitors/events) for a site+range; subject is the dataset (`<origin>/sites/<id>`). |

Both return `501` when no signing key is configured (or the key is not Ed25519). Verify offline with
`facet verify credential <file> --jwk <jwk>` (or `--key <publicKeyMultibase>`). Selective disclosure
(SD-JWT-style, Workers-native) is available via `@facet/trust`; the RDF-based `ecdsa-sd-2023` and
pairing-based `bbs-2023` cryptosuites are not usable under Cloudflare Workers (see the trust README).

## Transparency log, SCITT & attestation

A Merkle Mountain Range (MMR, profiled against `draft-bryce-cose-receipts-mmr-profile`) is maintained
over finalized `event_rollups` on the hourly cron, with signed checkpoints. All of this is inert
unless a signing key is configured. None of it commits anything about a visitor — leaves cover
aggregate rollups only.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/transparency/checkpoint` | public | Latest signed tree head (size + bagged root + timestamp). |
| `GET /api/transparency/inclusion?site_id&hostname&bucket_start&interval` | API key | Inclusion receipt for one of the site's rollups. |
| `GET /api/transparency/consistency?from&to` | public | Consistency proof between two tree sizes. |
| `POST /api/scitt/attestation` | admin | Wrap the PrivacyAttestation as a SCITT Signed Statement, register it with the local Transparency-Service double, return a Receipt. |
| `POST /api/scitt/register` | admin | Register an arbitrary Signed Statement, return a Receipt. |
| `GET /api/attestation/evidence[?nonce=]` | public | A RATS process-evidence EAT (software attestation only; no hardware root of trust). `nonce` must be **8–88 bytes** (RFC 9711 §4.1); anything else is a `400` rather than a signed EAT no conformant verifier would accept. |

Verify offline: `facet verify receipt <file>` (SCITT receipt / MMR inclusion) and
`facet verify attestation <file> [--nonce <n>]` (RATS EAT). The COSE_Sign1 wire form and an external
SCITT Transparency Service (`SCITT_URL`) are integration points — see the trust README for the
Workers runtime boundaries (COSE/CBOR, `ecdsa-sd-2023`, `bbs-2023`, hardware RATS).

---

## Goals, conversions & funnels

Goals and funnels are per-site configuration. **Creating and deleting** them is
admin-only (`Authorization: Bearer <ADMIN_TOKEN>`). **Reading** the catalog and running
conversion/funnel reports uses a site-scoped stats **API key** so the dashboard can query
them without the admin token.

A goal matches by event `name` (`type: "event"`) or `path` (`type: "path"`). A session
"converts" when it contains at least one matching event within the session window. A funnel
is 2–10 ordered steps; a session reaches step *i* when its time-ordered events match steps
`0..i` in order.

### `POST /api/goals` (admin)

Body: `{ "site_id": UUID, "name": string (1–100), "type": "event" | "path", "match_value": string (1–2048) }`.
Returns `201`.

```sh
curl -X POST https://your-deployment.example.com/api/goals \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"site_id":"11111111-1111-4111-8111-111111111111","name":"Signup","type":"event","match_value":"signup"}'
```

```json
{
  "goal": {
    "id": "33333333-3333-4333-8333-333333333333",
    "created_at": 1704067200000,
    "site_id": "11111111-1111-4111-8111-111111111111",
    "name": "Signup",
    "type": "event",
    "match_value": "signup"
  }
}
```

### `GET /api/goals?site_id=<uuid>` (admin)

Lists a site's goals, newest first. Returns `200` with `{ "goals": [...] }`.

```sh
curl "https://your-deployment.example.com/api/goals?site_id=11111111-1111-4111-8111-111111111111" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### `DELETE /api/goals/:id?site_id=<uuid>` (admin)

Deletes a goal scoped to its site. Returns `200` with `{ "deleted": true }`, or
`404 not_found` if no match.

### `GET /api/stats/goals?site_id=<uuid>` (API key)

Catalog read for the dashboard. **API key**: `Authorization: Bearer <clk_...>`; the key
must own `site_id` (else `403 site_mismatch`). Returns `200`.

```sh
curl "https://your-deployment.example.com/api/stats/goals?site_id=11111111-1111-4111-8111-111111111111" \
  -H "Authorization: Bearer clk_localdevkey"
```

```json
{
  "goals": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "site_id": "11111111-1111-4111-8111-111111111111",
      "name": "Signup",
      "type": "event",
      "match_value": "signup",
      "created_at": 1704067200000
    }
  ]
}
```

### `GET /api/stats/conversions?site_id&goal_id&start&end` (API key)

Conversion report for a single goal. **API key**: `Authorization: Bearer <clk_...>`; the
key must own `site_id` (else `403 site_mismatch`). Returns `404 not_found` if the goal does
not exist or belongs to another site. `rate = conversions / sessions` (0 when there are no
sessions in range).

| Param | Required | Notes |
| --- | --- | --- |
| `site_id` | yes | UUID; key-owned. |
| `goal_id` | yes | Goal id. |
| `start` | yes | Inclusive range start, unix ms. |
| `end` | yes | Exclusive range end, unix ms. `> start`, range ≤ 90 days. |

```sh
curl "https://your-deployment.example.com/api/stats/conversions?site_id=11111111-1111-4111-8111-111111111111&goal_id=33333333-3333-4333-8333-333333333333&start=1704067200000&end=1704672000000" \
  -H "Authorization: Bearer clk_localdevkey"
```

```json
{
  "goal_id": "33333333-3333-4333-8333-333333333333",
  "conversions": 5,
  "sessions": 12,
  "rate": 0.4167
}
```

### `POST /api/funnels` (admin)

Body: `{ "site_id": UUID, "name": string (1–100), "steps": [{ "type": "event" | "path", "match_value": string (1–2048) }] }`.
`steps` must have **2–10** entries. Returns `201`.

```sh
curl -X POST https://your-deployment.example.com/api/funnels \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "site_id": "11111111-1111-4111-8111-111111111111",
    "name": "Checkout",
    "steps": [
      { "type": "path", "match_value": "/pricing" },
      { "type": "path", "match_value": "/checkout" },
      { "type": "event", "match_value": "purchase" }
    ]
  }'
```

```json
{
  "funnel": {
    "id": "44444444-4444-4444-8444-444444444444",
    "site_id": "11111111-1111-4111-8111-111111111111",
    "name": "Checkout",
    "steps": [
      { "type": "path", "match_value": "/pricing" },
      { "type": "path", "match_value": "/checkout" },
      { "type": "event", "match_value": "purchase" }
    ],
    "created_at": 1704067200000
  }
}
```

### `GET /api/funnels?site_id=<uuid>` (admin)

Lists a site's funnels, newest first. Returns `200` with `{ "funnels": [...] }`.

### `DELETE /api/funnels/:id?site_id=<uuid>` (admin)

Deletes a funnel scoped to its site. Returns `200` with `{ "deleted": true }`, or
`404 not_found`.

### `GET /api/stats/funnels?site_id=<uuid>` (API key)

Catalog read for the dashboard. **API key**: `Authorization: Bearer <clk_...>`; key must
own `site_id`. Returns `200` with `{ "funnels": [...] }` (same shape as the admin list).

### `GET /api/funnels/:id/report?site_id&start&end` (API key)

Runs the funnel over the range. **API key**: `Authorization: Bearer <clk_...>`; key must
own `site_id` (else `403 site_mismatch`). Returns `404 not_found` if the funnel does not
exist for that site. `steps[i].count` is the number of sessions that reached step *i*;
`overall_rate = steps[last].count / steps[0].count` (0 when step 0 is 0).

| Param | Required | Notes |
| --- | --- | --- |
| `site_id` | yes | UUID; key-owned. |
| `start` | yes | Inclusive range start, unix ms. |
| `end` | yes | Exclusive range end, unix ms. `> start`, range ≤ 90 days. |

```sh
curl "https://your-deployment.example.com/api/funnels/44444444-4444-4444-8444-444444444444/report?site_id=11111111-1111-4111-8111-111111111111&start=1704067200000&end=1704672000000" \
  -H "Authorization: Bearer clk_localdevkey"
```

```json
{
  "steps": [
    { "index": 0, "match_value": "/pricing", "count": 40 },
    { "index": 1, "match_value": "/checkout", "count": 18 },
    { "index": 2, "match_value": "purchase", "count": 9 }
  ],
  "overall_rate": 0.225
}
```

---

## Experiments

Privacy-first A/B testing. Variant assignment is computed **client-side** from a random
`localStorage['facet.exp']` id (never sent as identity); the server only stores aggregate
`$exposure` events and conversions. In the browser, `window.facet.variant('flag_key')` returns
the assigned variant and fires one `$exposure` event per flag per page load.

### `POST /api/experiments` (admin)

Body `{ site_id, name, flag_key, variants: [{ key, weight }], active? }` (2–8 variants; the first is
the control). Returns `201` with `{ "experiment": { ... } }`.

### `GET /api/experiments?site_id=<uuid>` (admin) · `DELETE /api/experiments/:id?site_id=<uuid>` (admin)

List (variants parsed, `active` as boolean) and delete, same contract as goals/funnels.

### `GET /api/experiments/active?site_id=<uuid>` (public)

Client-facing flag config — **no auth** (these definitions are inherently public to the browser).
Returns only active experiments: `{ "experiments": [{ "id", "flag_key", "variants": [...] }] }`.

### `GET /api/stats/experiments?site_id=<uuid>` (API key)

Catalog read for the dashboard (key must own `site_id`).

### `GET /api/stats/experiment?site_id&experiment_id&goal_type&goal_value&start&end` (API key)

Results per variant: exposures, distinct-visitor conversions against the goal
(`goal_type` = `event|path`, matched on `goal_value`), conversion `rate`, and a two-proportion
z-test `p_value` vs the control with a `significant` flag (α = 0.05; control's `p_value` is `null`).

```json
{
  "variants": [
    { "key": "control", "exposures": 1000, "conversions": 100, "rate": 0.1, "p_value": null, "significant": false },
    { "key": "b", "exposures": 1000, "conversions": 150, "rate": 0.15, "p_value": 0.00072, "significant": true }
  ]
}
```

## Feature flags

Feature flags are richer than experiments: they add targeting **rules** (first-match by priority,
clauses AND-ed) on top of a base percentage rollout, and evaluate through **one shared evaluator**
used identically by the server, the browser SDK, and the dashboard preview — so an assignment can
never diverge between them. Bucketing is a SHA-256 draw in the integer domain (`u64 % 10000`) keyed
on the caller's stable `facet.exp` id (never the rotating visitor hash), so assignments are sticky
across the daily salt rotation. Variant `weight`s are integer **basis points** and must sum to
`10000`. No visitor identity is stored; the id is an opaque bucketing key.

### `POST /api/flags` (admin) · `PATCH /api/flags/:id` (admin)

Body `{ site_id, flag_key, name, type: "boolean"|"multivariate", enabled?, default_variant,
variants: [{ key, weight }], rules?: [{ priority, clauses: [{ attr, op, value }], serve }] }`.
`op` ∈ `eq|neq|in|nin|contains|prefix|gte|lte|pct`; `serve` is `{ variant }` or
`{ rollout: [{ key, weight }] }`. Beyond schema validation the server enforces: variant weights sum
to `10000`, `default_variant` is a declared variant, and every rule serves only declared variants
(else `400` with an `error` code such as `variant_weights_must_sum_to_10000`). A duplicate
`(site_id, flag_key)` returns `409 flag_key_already_exists`. `salt` is minted once at create and
never changes (rotating it would rebucket everyone); each write bumps `version`. `PATCH` is scoped
by `(id, site_id)`.

### `GET /api/flags?site_id=<uuid>` (admin) · `DELETE /api/flags/:id?site_id=<uuid>` (admin)

List the full records (rules + metadata) and delete, scoped by `(id, site_id)`.

### `GET /api/flags/active?site_id=<uuid>` (public)

Cacheable bucketing config for **enabled** flags only — **no auth**. It ships exactly what a client
needs to bucket base rollout offline and **nothing more**: `{ "flags": [{ "flag_key", "type",
"enabled", "default_variant", "variants", "salt", "rollout_seed", "version" }] }`. Targeting `rules`
are deliberately **withheld** (they stay server-side; use `/eval` for targeted evaluation). Sends a
weak `ETag` over the flags' versions with `Cache-Control: public, max-age=60`; a matching
`If-None-Match` returns `304`, and any flag change (including a kill-switch toggle) turns the ETag
over.

### `POST /api/flags/eval` (public, rate-limited)

Server-side evaluation applying the full ruleset. Body `{ site_id, id?, keys?, gpc?, ctx? }` where
`ctx` is `{ country?, device?, path?, host?, channel?, lang?, custom? }` (`custom` is bounded — it is
visitor-asserted and untrusted). The server overlays **authoritative** `country`/`device` derived
from the request onto `ctx` (a browser can't know geo and could spoof it). Returns
`{ "flags": { "<flag_key>": { "variant", "participating", "reason" } } }` where `reason` is
`disabled|rollout|rule:<priority>|gpc`. A `Sec-GPC: 1` header (or `gpc: true`) serves every flag its
default with `participating: false`, `reason: "gpc"` — no bucketing occurs.

---

## `GET /api/stats/anomalies?site_id&start&end` (API key)

Automated anomaly detection with a plain-language root-cause "autopsy". Scores the most recent hour
of pageviews against the earlier hours in the range (sample z-score); when the deviation exceeds
`ANOMALY_Z` (3.0) it returns the anomaly plus the largest-contributing segment
(`device` / `country` / `channel`) and a summary sentence. Returns `{ "anomalies": [] }` when nothing
is anomalous or the baseline is too short. **API key**; key must own `site_id`. Same
`bad_range` / `range_too_large` rules as the other stats reads.

```json
{
  "anomalies": [
    {
      "metric": "pageviews",
      "bucket": 1704672000000,
      "value": 3,
      "baseline_mean": 42,
      "z": -4.1,
      "direction": "drop",
      "diagnosis": { "dimension": "device", "value": "mobile", "current": 1, "baseline_avg": 25 },
      "summary": "Pageviews dropped 93% in the last hour (z=-4.1). Largest contributor: device=mobile (1 vs ~25 typical)."
    }
  ]
}
```

---

## `POST /api/stats/query` (API key)

Natural-language analytics query. A plain-English question is translated **via Workers AI**
into a constrained, validated query **intent** (never raw SQL) and executed over the existing
aggregate stats helpers. **API key**: `Authorization: Bearer <clk_...>`; the site is taken
from the key and the body's `site_id` must match it (else `403 site_mismatch`). Requires the
`AI` binding; without it the endpoint returns `503 ai_unavailable`.

**Body:** `{ "site_id": UUID, "question": string (1–500 chars), "start": ms, "end": ms }`
(`> start`, range ≤ 90 days).

The intent chooses a `metric` (`pageviews` / `visitors` / `events` / `sessions` /
`bounce_rate`) and, optionally, a `dimension` (`path` / `referrer` / `country` / `device` /
`channel`) with a `limit`. An intent may instead set `"series": true` with an
`"interval": "hour" | "day"` to request a trend. The `result` is therefore one of three
shapes:

- `{ "kind": "scalar", "value": number }` — a single total.
- `{ "kind": "breakdown", "rows": [{ "key", "count" }] }` — a top-N breakdown by dimension.
- `{ "kind": "series", "points": [{ "t", "pageviews", "visitors" }] }` — a time series
  (`series: true` in the intent; ignored if a dimension is set).

```sh
curl -X POST https://your-deployment.example.com/api/stats/query \
  -H "Authorization: Bearer clk_localdevkey" \
  -H "content-type: application/json" \
  -d '{"site_id":"11111111-1111-4111-8111-111111111111","question":"pageviews per day this week","start":1704067200000,"end":1704672000000}'
```

```json
{
  "intent": { "metric": "pageviews", "series": true, "interval": "day" },
  "answer": "Pageviews are trending up over the range.",
  "result": {
    "kind": "series",
    "points": [
      { "t": 1704067200000, "pageviews": 4, "visitors": 3 },
      { "t": 1704153600000, "pageviews": 5, "visitors": 4 }
    ]
  }
}
```

---

## Identity spectrum & consent

Opt-in, consent-gated linkage on top of the default daily-rotating anonymous hash. See
[privacy.md](./privacy.md#identity-spectrum-opt-in-consent-gated) for the model and threat analysis.
Every tier above `anonymous` requires a configured deployment signing key (`FACET_SIGNING_JWK`); with
none, these endpoints `501` and every site stays at Tier 0.

### `PATCH /api/sites/:id/identity` (admin)

Body `{ tier: "anonymous"|"pseudonymous"|"identified", salt_window: "day"|"week"|"month" }`. Sets the
site's tier. The site must exist (`404` otherwise); elevating without a signing key returns
`501 identity_signing_unconfigured`; `anonymous` forces the `day` window. Returns
`{ "identity": { site_id, tier, salt_window } }`.

### `POST /api/consent` (API key, rate-limited)

Records a visitor's consent so ingest may elevate them. Body `{ tier, salt_window, user_id?, ip?,
user_agent?, expires_at? }` (`user_id` required for `identified`). `site_id` comes from the API key,
never the body. GPC is checked first — a `Sec-GPC: 1` request returns `202` and writes nothing. Derives
the current-window hash, signs a PII-free `facet-consent/1` statement (the derived hash + tier + window
only — never ip/ua/raw uid), stores it, and returns `{ "consent": <SignedStatement> }` (`201`) for the
caller's audit trail. `400 site_not_elevated` if the site is Tier 0; `501` without a signing key.

### `DELETE /api/consent` (API key, rate-limited)

Body `{ tier, salt_window, user_id? | ip?, user_agent? }`. Revokes by raw `user_id` (Tier 2) or by the
derived current-window hash (Tier 1), setting `revoked_at` on **every** matching active row so a
captured statement can't re-elevate. Returns `{ "revoked": <n> }`.

### `GET /api/stats/retention?site_id&start&end&period=day|week` (API key)

Cohort-retention triangle: visitors grouped by the period of their first activity, each cell the
fraction returning `n` periods later. Returns `{ period, cohorts: [{ cohort, size, retention: [...] }],
note }`. **Retention depth is bounded by the salt window** (see `note`): at the default daily window a
returning visitor gets a new hash each day, so multi-period retention is legitimately ~0 — a wider
window via the identity spectrum is required for longer retention.

---

## Admin: sites and keys

All admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

### `POST /api/sites`

Body: `{ "name": string (1–100), "domain": string (1–253) }`. Returns `201`.

```sh
curl -X POST https://your-deployment.example.com/api/sites \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"My Site","domain":"example.com"}'
```

```json
{
  "site": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "My Site",
    "domain": "example.com",
    "created_at": 1704067200000
  }
}
```

### `PATCH /api/sites/:id/team`

Body: `{ "team_id": string | null }`. Assigns the site to a team, which is what grants that team's
members dashboard-session access to it (`GET /api/auth/me` returns a user's team ids). Passing `null`
unassigns the site, revoking every session's access in one step — API-key access is unaffected either
way. `404 not_found` for an unknown site, `400 unknown_team` for an unknown team.

```sh
curl -X PATCH https://your-deployment.example.com/api/sites/11111111-1111-4111-8111-111111111111/team \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"team_id":"a1b2c3d4e5f6"}'
```

### `GET /api/sites`

Lists all sites, newest first. Returns `200`.

```sh
curl https://your-deployment.example.com/api/sites \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "sites": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "My Site",
      "domain": "example.com",
      "created_at": 1704067200000
    }
  ]
}
```

### `POST /api/keys`

Keys can be limited with `scopes`: `read` (analytics and MCP), `write` (custom events), and
`consent` (consent records). Omitting it preserves compatibility by granting all three.

Issue an API key for a site. Body: `{ "site_id": UUID, "label"?: string (≤ 100) }`.
Returns `201`. The plaintext `key` is shown **once** and is never retrievable again (only
its hash is stored).

```sh
curl -X POST https://your-deployment.example.com/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"site_id":"11111111-1111-4111-8111-111111111111","label":"reporting"}'
```

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "key": "clk_<64-hex-characters>"
}
```

### `GET /api/keys?site_id=<uuid>`

List a site's keys (metadata only — never the hash or plaintext). `site_id` is required;
omitting it returns `400 bad_request`. Returns `200`.

```sh
curl "https://your-deployment.example.com/api/keys?site_id=11111111-1111-4111-8111-111111111111" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "keys": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "site_id": "11111111-1111-4111-8111-111111111111",
      "label": "reporting",
      "created_at": 1704067200000,
      "last_used": null
    }
  ]
}
```

### `DELETE /api/keys/:id?site_id=<uuid>`

Revoke a key by id, scoped to its site. `site_id` is required (`400 bad_request` if
missing). Returns `200` with `{ "deleted": true }`, or `404 not_found` if no matching key.

```sh
curl -X DELETE "https://your-deployment.example.com/api/keys/22222222-2222-4222-8222-222222222222?site_id=11111111-1111-4111-8111-111111111111" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{ "deleted": true }
```

### `POST /api/users/:id/revoke-sessions` (admin token)

Ends every session the named operator holds — the same mechanism as `/api/auth/logout-everywhere`,
applied to someone else. Returns `{ "user_id": "...", "sessions_revoked": true }`, or `404` when
there is no such user, so a mistyped id is never reported as a revocation that did not happen.
Idempotent: revoking twice is two epochs and the same outcome.

This is **the lever the CRM audit log points at.** The log names the operator whose session read the
contact table; without this route the only person who could act on that was that operator, which is
precisely the wrong person when the question is whether their session was stolen.

In the dashboard: **Settings → Operator sessions**, above the site selection because sessions belong
to a person and to the whole deployment, not to the site being managed. It takes a pasted user id
rather than offering a picker, for the same reason the route is behind `ADMIN_TOKEN` — there is no
user directory to pick from. The ids come from the **Who** column of the CRM access log. Revoking is
not a lockout: roles and data are untouched and the person can sign in again immediately.

It sits behind `ADMIN_TOKEN` rather than a team role, and that is a deliberate limit. Team admins
have no user-management surface at all today — they cannot list their members, rename them, or remove
them — so a route reaching across to another person's sessions would be the first of its kind,
arriving without any of the structure that should come with it.

### `GET /api/bots/ruleset` (admin token)

Reports the operator-refreshable crawler ruleset: one entry per stored source with its
`pattern_count`, `updated_at` and upstream `etag`, plus `active_patterns` — how many are compiled and
live in the isolate answering the request. Returns `501 bot_ruleset_unconfigured` when
`FACET_BOT_RULESET_URL` is unset, which is distinct from a refresh that failed.

```json
{
  "rulesets": [{ "source": "remote", "pattern_count": 412, "updated_at": 1756000000000, "etag": "W/\"a1b2\"" }],
  "active_patterns": 412
}
```

`active_patterns` can lag `pattern_count` briefly: each isolate re-reads the stored ruleset at most
once a minute, so a just-refreshed set reaches the rest of them within that window.

### `POST /api/bots/refresh` (admin token)

Re-fetches `FACET_BOT_RULESET_URL` immediately instead of waiting for the daily cron, and returns the
same body as the status route. The fetch is conditional on the stored `etag`, so an unchanged
upstream writes nothing.

Fetched patterns are **additive only** — they can add crawlers to drop, never prevent the compiled-in
list from dropping one — so no upstream response can make the deployment start recording bot traffic.
Payloads are bounded (2000 patterns, 200 chars each, 512 KB body) and individual patterns are dropped
if they fail to compile, match a catastrophic-backtracking shape, or match an ordinary desktop
browser.

Errors: `501 bot_ruleset_unconfigured` when the var is unset, `400 bot_ruleset_misconfigured` when it
is set but unusable (not absolute, or not `https:`), and `502 bot_ruleset_refresh_failed` for every
upstream failure. The upstream URL, status and body are never echoed, so an admin-facing error cannot
be turned into a report on an arbitrary host.

---

## Admin: alert destinations and metric thresholds

Where anomaly and metric-threshold alerts are delivered, plus the conditions operators define.
**Admin token only** for every route — alert configuration decides where a deployment's data is
sent, so a site API key must never reach it.

### `POST /api/alerts`

Body: `{ "site_id": UUID, "name": string (1–100), "type": "webhook"|"email", "target": string
(1–2048), "min_severity"?: "info"|"warning"|"critical", "enabled"?: boolean }`. `min_severity`
defaults to `warning`; `enabled` defaults to `true`. Returns `201`.

`target` is re-validated server-side beyond schema shape: a `webhook` target must survive the
SSRF policy (`400 invalid_webhook_url`), an `email` target must be a mailbox
(`400 invalid_email_target`). A webhook destination is issued an HMAC signing `secret`, returned
**once** in this response and never disclosed again — the list endpoint omits it. Lost it? Delete
the destination and create another (same handling as an API key).

```json
{
  "alert_destination": {
    "id": "33333333-3333-4333-8333-333333333333",
    "site_id": "11111111-1111-4111-8111-111111111111",
    "name": "ops webhook",
    "type": "webhook",
    "target": "https://hooks.example.com/facet",
    "min_severity": "warning",
    "enabled": true,
    "created_at": 1704067200000
  },
  "secret": "…shown once…"
}
```

### `GET /api/alerts?site_id=<uuid>`

Lists a site's destinations, newest first, as `{ "alert_destinations": [...] }`. The `secret`
column is never included.

### `DELETE /api/alerts/:id?site_id=<uuid>`

Deletes a destination scoped to its site. Returns `{ "deleted": true }`, or `404 not_found`.
Delivery history is intentionally retained — it is the audit trail of what was sent.

### `POST /api/alerts/rules`

Creates an immutable threshold rule. Body:
`{ "site_id": UUID, "name": string (1–100), "metric": "pageviews"|"visitors"|"events",
"operator": "at_least"|"at_most", "threshold": non-negative integer,
"severity"?: "info"|"warning"|"critical", "enabled"?: boolean }`. Severity defaults to
`warning`; enabled defaults to `true`. Returns `201` with `{ "metric_alert_rule": ... }`.

Rules are checked by the existing hourly cron against the exact D1 summary for the last **completed
UTC hour**. Operators are inclusive. A matched rule is sent once per `(destination, rule, hour)` to
every enabled destination whose `min_severity` accepts the rule's severity. A delayed or duplicate
cron trigger therefore cannot send the same observation twice; a rule that remains breached in the
next hour is a new observation and may alert again.

The initial metric set is deliberately currency-free and available from one exact query. Revenue is
not accepted because a threshold without a currency is ambiguous on mixed-currency sites; session
metrics are not accepted because they materialize in a separate scheduled job.

```json
{
  "metric_alert_rule": {
    "id": "44444444-4444-4444-8444-444444444444",
    "site_id": "11111111-1111-4111-8111-111111111111",
    "name": "traffic disappeared",
    "metric": "pageviews",
    "operator": "at_most",
    "threshold": 0,
    "severity": "critical",
    "enabled": true,
    "window_minutes": 60,
    "created_at": 1704067200000
  }
}
```

### `GET /api/alerts/rules?site_id=<uuid>`

Lists a site's metric rules, newest first, as `{ "metric_alert_rules": [...] }`.

### `DELETE /api/alerts/rules/:id?site_id=<uuid>`

Deletes a rule scoped to its site. Returns `{ "deleted": true }`, or `404 not_found`. Prior
delivery rows remain as the audit trail. Rules are immutable so a rule id and its dedupe keys never
change meaning; replace a rule to change its condition.

---

## Account auth (dashboard sign-in)

Passwordless sign-in for the dashboard UI, entirely separate from the per-site API-key path. All
of it is gated on `SESSION_SECRET`: without that binding every route below returns
`503 auth_unavailable`, and the beacon plus programmatic stats endpoints are unaffected.

### `POST /api/auth/request` (public, rate-limited)

Body `{ "email": string (≤ 254, valid address) }`. Mints and emails a single-use magic-link token.
Returns `202` with an empty body whether or not the address has an account, so the response never
reveals which. Email sign-in requires the `SEND_EMAIL` binding and an `AUTH_EMAIL_FROM` verified
sender; without both, it returns `503 auth_email_unavailable` and writes no token. The authenticated
`/admin-link` bootstrap flow remains available without email.

Rate-limited **per client IP**, and separately from `/verify` so that a burst of sign-in requests
from one shared address cannot stop the people behind it redeeming links they already hold. Because
the route cannot check whether an address has an account before writing — that check is exactly what
would leak the answer — the limit is what bounds an anonymous caller's writes, and on a deployment
with an email sender bound, the mail those writes would send.

Tokens live 15 minutes and are deleted by the retention cron once they expire, so an address that
requested a link and never used it leaves nothing behind.

### `POST /api/auth/admin-link` (admin)

Body `{ "email": … }`. The self-hosted bootstrap/invite path: an operator holding `ADMIN_TOKEN`
mints a magic link and gets it back directly as `{ email, token, link }`. This is what makes
sign-in work with **no** email service configured.

### `POST /api/auth/verify` (public, rate-limited)

Body `{ "token": string (3–200) }`. Consumes the token and sets an HMAC-signed, `httpOnly`,
`Secure`, `SameSite=Lax` session cookie (30 days). Returns `{ "user": … }`, or
`401 invalid_token` when the link is invalid, already used, or expired.

Rate-limited per client IP, in its own bucket. The token secret is 192 bits, so the limit is not
what makes guessing infeasible; it stops each guess costing a database read.

### `GET /api/auth/me` (session cookie)

Returns `{ "user": …, "memberships": [...] }` for the signed-in user, or `401 unauthenticated`.

### `POST /api/auth/logout` (session cookie)

Clears the session cookie. Returns `204`. **This ends the session in that browser only.** A session
token is HMAC-signed and self-contained, so a token already copied out of the browser keeps working
until it expires — deleting the cookie does nothing to it.

### `POST /api/auth/logout-everywhere` (session cookie)

Ends **every** session this operator holds, anywhere, and clears the cookie of the browser that
asked. Returns `204`, or `401 unauthenticated`. This is the remedy for a session you believe was
stolen; `/logout` is not.

In the dashboard: **Settings → Your account**, which sits outside the admin-token gate because this
is authorized by your own cookie. It renders only when `/api/auth/me` resolves, so a deployment
without `SESSION_SECRET` — which has no accounts at all — shows nothing rather than a panel
explaining it cannot be used.

It works by moving the user's `session_epoch` past the one every outstanding token carries. Each
token records the epoch it was signed at and resolves only while the two still match, so one
increment ends all of them at once. Deliberately all-or-nothing: Facet keeps no session table, so
there is no device list to revoke from, and the honest control is the one that ends everything.

Signing back in afterwards works normally — revocation ends the sessions, not the ability to have
one. Two consequences worth knowing: a token minted before this existed carries no epoch and is
rejected rather than assumed valid, so every operator signs in once after upgrading; and deleting a
user row also ends their sessions, since an account that does not exist holds none.

---

## CRM (optional extension)

The CRM is **off unless you bind it**. It lives in a second D1 database (`CRM_DB`); with no binding
there is no database, no table, and every route below returns `501 crm_unavailable` — before
authentication, so an unbound deployment answers uniformly. See `apps/server/wrangler.jsonc` for how
to turn it on, and note that doing so changes the DPV claims this deployment signs at
`/.well-known/facet-privacy.json` (it gains `dpv:Store`, `dpv:Erase`, `dpv:Consent`, and the
`pd:` categories it holds — including `pd:CurrentEmployment`, because a contact linked to a company
record carries a structured employer that a free-text box did not, and `pd:Transactional`, because a
deal linked to `contact_id` attaches a monetary pipeline value to a named person).

Every route is rate limited per *operator* (not per site, so one compromised session cannot hide
inside its team's traffic), write bodies are capped at 16 KB, and every authorized request — reads
included — is written to the [audit log](#get-apicrmauditsite_idactionactor_user_idtarget_idlimitoffset-session-admin)
before its handler runs.

**Auth is a session cookie, never an API key.** This is the one authenticated surface that refuses
`Authorization: Bearer <clk_...>`. A `clk_` key authorizes aggregate analytics and is meant to be
handed out — to agents, to a public demo dashboard — and contact PII is not something that survives
that. Every route takes `?site_id=<uuid>`, and the caller must hold a role on the team that owns it
(assign one with `PATCH /api/sites/:id/team`). `503 auth_unavailable` without `SESSION_SECRET`;
`401 unauthorized` without a session; `403 forbidden` when the role is insufficient.

| Role | Contacts, companies and deals |
| --- | --- |
| `viewer` | no access at all |
| `analyst` | list, read, create, update, view the analytics link, read the pipeline summary |
| `admin` / `owner` | the above, plus delete, export, and read the audit log |

### `GET /api/crm/contacts?site_id&status&q&limit&offset` (session, analyst)

Lists contacts, newest first. `status` ∈ `lead \| active \| archived`; `q` is a bounded substring
match over name/email/company (LIKE metacharacters are escaped, so `q=%` matches a literal `%`). The
company it matches on is the **resolved** one, so searching a company name finds the contacts linked
to it as well as those carrying it as free text. `limit` defaults to 25, max 100. Returns
`{ contacts: [...], total, role }`.

`role` is the team role this request was authorized under. It is on the list responses because a
client has no other way to learn it: `GET /api/auth/me` reports a role per *team*, and no
session-reachable route says which team owns a given site, so a UI deciding whether to offer the
admin-only delete and export could otherwise only guess. `offset` is capped at 100,000 — SQLite walks
every skipped row, so an unbounded one is a full table scan.

### `POST /api/crm/contacts?site_id` (session, analyst)

Body: `{ external_user_id?, email?, name?, phone?, company?, company_id?, title?, status?, source?,
notes?, owner_user_id? }`. `site_id` comes from the query parameter, **never** the body. Requires at
least one of `email`, `external_user_id` or `name` — a row with none can never be matched or erased
on request. Email is lowercased; `(site_id, email)` and `(site_id, external_user_id)` are unique, so
a duplicate returns `409 contact_exists`. An `owner_user_id` that matches no user returns
`400 unknown_owner`. Returns `201`.

`company` and `company_id` are the same fact recorded two ways — free text, or a link to a
`companies` row — and **exactly one of them answers at a time**. Sending both as non-empty is
`400 company_conflict`; a `company_id` that is not a company on this site is `400 unknown_company`
(the foreign key would accept another site's, so the site check is what rejects it). A non-empty
write to either clears the other. Reads return `company` resolved to the linked company's **current**
name, falling back to the free text when nothing is linked, so renaming a company changes every
linked contact with no backfill. `company_id` is returned alongside it, so a link is still
distinguishable from a label.

### `GET`/`PATCH /api/crm/contacts/:id?site_id` (session, analyst)

`PATCH` is partial: only keys present in the body are written, so omitting `notes` leaves the notes
alone. A contact belonging to another site is `404 not_found`, indistinguishable from a missing one.

### `DELETE /api/crm/contacts/:id?site_id` (session, admin)

**Really deletes** — no tombstone, because a tombstone still holding an email is still that person's
personal data. Also erases (not revokes) every `consent_records` row for their `external_user_id`,
since those rows hold the raw identifier the erasure was about, and unlinks (not deletes) every deal
naming this contact, the same "unlink, don't destroy" precedent as a company delete. Returns
`{ "deleted": true, "consent_records_erased": <n>, "deals_unlinked": <n> }`. The pseudonymous event
rows remain; with the consent record gone, nothing can re-associate them with a person.

### `GET /api/crm/contacts/:id/analytics?site_id` (session, analyst)

The **consent-gated** link. Resolves the contact's `external_user_id` through `consent_records` and
returns activity only for visitor hashes taken from consent statements that verify against the
deployment signing key. The hash comes from the signed claims, never from a column, so a hand-written
row cannot attach a contact to an arbitrary visitor.

Returns `{ "linked": false, "reason": "no_external_user_id" | "no_active_consent" }`, or
`{ "linked": true, "windows": <n>, "activity": { pageviews, events, first_seen, last_seen,
top_paths } }`. `windows` is how many salt windows currently have a live grant; it shrinks on its own
as retention purges older consent records, and when the last one goes the link severs with no
CRM-side cleanup — nothing here caches a visitor hash.

Contacts themselves are **not** on the retention schedule. A contact is a business record with its
own lifecycle; only the link to analytics is time-bounded.

### `GET /api/crm/contacts/:id/export?site_id` (session, admin)

Data-subject export: `{ exported_at, contact, consent: [...], analytics: { linked, windows, activity,
events, events_truncated, events_limit } }`. The `consent` entries include each signed statement
verbatim — they are PII-free by construction, so they add cryptographic evidence of what was
consented to without widening what the export discloses. `events` is capped at `events_limit` (1000)
and `events_truncated` says so explicitly rather than silently returning a prefix.

### `GET`/`POST /api/crm/companies?site_id` (session, analyst)

A company is an organization, not a data subject — a name, a domain and a note about a legal person
are nobody's personal data. Body: `{ name, domain?, status?, notes?, owner_user_id? }`. `name` is
required. `domain` is normalised before it is stored — lowercased, with the scheme, path, port and
any trailing dot removed, so `https://Acme.com/about` and `acme.com` are one company; `www.` is
deliberately **not** stripped, since deciding that `www.acme.com` is the same organization as
`acme.com` is a guess. A domain that is not a hostname is `400`. `(site_id, name)` and
`(site_id, domain)` are unique, so a duplicate returns `409 company_exists`.

Name uniqueness is an **exact** match: names are displayed as typed, so they are not case-folded for
the index. Use `domain` if you want a case-insensitive identity key.

`GET` takes `status`, `q` (substring over name/domain), `limit`, `offset` and returns
`{ companies: [...], total, role }`, with `role` as on the contacts list.

### `GET`/`PATCH /api/crm/companies/:id?site_id` (session, analyst)

`PATCH` is partial. A `name` that is present must be non-blank (`companies.name` is NOT NULL and is
the display value); omitting it leaves it alone.

### `DELETE /api/crm/companies/:id?site_id` (session, admin)

**Deletes the company, not the people or the deals attached to it.** Deleting an organization is not
an erasure request about anybody, so its contacts survive: each one's `company_id` is cleared and the
company's name is written back into their free-text `company`, in a single D1 batch. "Where does this
person work" therefore answers the same before and after — only the structured link is gone. Any deal
naming this company is unlinked the same way, its `company_id` cleared. Returns
`{ "deleted": true, "contacts_unlinked": <n>, "deals_unlinked": <n> }`.

### `GET /api/crm/companies/:id/contacts?site_id&limit&offset` (session, analyst)

That company's contacts, newest first, in the same resolved shape the contact list returns.

### `GET /api/crm/companies/:id/analytics?site_id` (session, analyst)

The company rollup: the **sum of its contacts' individually consent-gated links**, never a query over
"the company". Every visitor hash comes from the same verified-statement gate the per-contact route
uses, applied per contact, so a contact with no active signed consent contributes nothing — the
aggregate is exactly the union of the per-contact results the same caller can already fetch one at a
time, and is strictly less revealing than the calls it replaces.

There is deliberately **no k-anonymity floor**, unlike the analytics breakdowns. `K_ANON` protects
visitors the operator has no other route to; these are contacts the same caller can already retrieve
individually and by name, so a floor would suppress a two-contact company's rollup while both of
their pages stayed readable — hiding a legitimate answer while protecting nobody.

What does need saying is the denominator, so it is in the response:

```json
{
  "contacts_total": 12,       // contacts at this company, including those that can never link
  "contacts_linked": 3,       // of those considered, how many consent currently authorizes
  "contacts_considered": 12,  // how many were resolved (bounded by contacts_limit)
  "contacts_truncated": false,
  "contacts_limit": 100,
  "linked": true,
  "visitor_hashes": 4,
  "activity": { "pageviews": 0, "events": 0, "total": 0, "first_seen": null, "last_seen": null, "top_paths": [] }
}
```

`contacts_total` beside `contacts_linked` is what stops "142 pageviews" for a twelve-person account
reading as the account's traffic when it is one person's. `contacts_truncated` is never silent: a
capped fan-out is a lower bound, not a total. `visitor_hashes` is contacts multiplied by their live
salt windows — a linkage-breadth number, **not** a headcount; `contacts_linked` is the headcount.
When nothing is linked the response is `{ ..., "linked": false, "reason": "no_linked_contacts" }`
rather than zeroes that would read as "this account did nothing". When the fan-out was capped the
reason is `none_linked_within_cap` instead — with contacts left unexamined, "nobody is linked" is a
claim about rows nothing looked at.

There is **no company export**. A data-subject export is per person by definition; a company-wide one
would be a bulk PII dump with no data-protection meaning. Use `/companies/:id/contacts` and then the
per-contact export, which accounts for each person separately.

### `GET /api/crm/deals?site_id&stage&company_id&contact_id&q&limit&offset` (session, analyst)

Lists deals, newest first. `stage` ∈ `lead \| qualified \| proposal \| negotiation \| won \| lost`; `q`
is a bounded substring match over the deal name; `company_id`/`contact_id` filter to that record's
deals. `limit` defaults to 25, max 100. Returns `{ deals: [...], total, role }`.

### `POST /api/crm/deals?site_id` (session, analyst)

Body: `{ name, company_id?, contact_id?, stage?, value?, currency?, expected_close_date?, notes?,
owner_user_id? }`. `name` is required. `value` is cents, matching how every other money amount in this
ecosystem avoids float rounding, and `currency` is a three-letter ISO 4217 code, uppercased on the
wire; they are one fact recorded in two columns, so sending one without the other is
`400 deal_value_needs_currency`. `expected_close_date` is Unix ms. A `company_id`/`contact_id` that
does not match a record on this site is `400 unknown_reference` — there is no unique index on `deals`,
so a stale reference is the only write failure a caller's input can cause. An `owner_user_id` that
matches no user is `400 unknown_owner`. Returns `201`.

A deal linked to `contact_id` makes that contact's data include `pd:Transactional`, the same way
`company_id` on a contact adds `pd:CurrentEmployment`.

### `GET`/`PATCH /api/crm/deals/:id?site_id` (session, analyst)

`PATCH` is partial: only keys present in the body are written. A `name` present in the body must still
be non-blank. A deal belonging to another site is `404 not_found`.

### `DELETE /api/crm/deals/:id?site_id` (session, admin)

**Deletes the deal**, matching contact delete rather than company delete: there is nothing here to
preserve by unlinking first, since a deleted deal is the opportunity itself going away, not a person or
organization losing a label. Returns `{ "deleted": true }`.

### `GET /api/crm/pipeline?site_id` (session, analyst)

The pipeline summary, one row per currency: `{ pipeline: [{ currency, open_value, open_count,
won_value, won_count }] }`. `open_value`/`won_value` are cents, summed in SQL across every deal on the
site. Deals with no `value`/`currency` are excluded, not counted as zero — a deal nobody has priced is
not a $0 deal. Values are never summed across currencies, which is why this is a list of per-currency
rows rather than one grand total that would add unlike units. `open` is every non-terminal stage;
`won`/`lost` are the only terminal ones, and `lost` deals count toward neither `open` nor `won`.

A top-level path — not `/deals/pipeline` — for the same reason `/audit` is top-level: it is a distinct
resource, not a deal by that id.

### `GET /api/crm/audit?site_id&action&actor_user_id&target_id&limit&offset` (session, admin)

The access log. **Every authorized request to any route above writes one entry, before its handler
runs** — reads included, which is the point: a delete leaves a hole you can see, a read leaves
nothing. An entry is `{ id, site_id, actor_user_id, actor_role, action, target_id, occurred_at,
actor_email }`, and the response is `{ entries: [...], total, role }`, newest first.

Written **first**, not last. Logging afterwards means any failure between the disclosure and the
record — a D1 error, a crash — leaves an access that happened and was never written down, and for a
delete there is then nothing left to notice the gap against. Writing first inverts that: if the log
write fails the request fails `500` and nothing was read or changed. The cost is that an entry states
an operator was *authorized* to do this to this id, not that it succeeded; a request that goes on to
`404` is recorded like any other. For the id-probing case that is the more useful reading anyway.

`action` is one of `contact.list`, `contact.create`, `contact.read`, `contact.update`,
`contact.delete`, `contact.analytics`, `contact.export`, `company.list`, `company.create`,
`company.read`, `company.update`, `company.delete`, `company.contacts`, `company.analytics`,
`deal.list`, `deal.create`, `deal.read`, `deal.update`, `deal.delete`, `deal.pipeline`,
`audit.read` — a closed set, so the log is filterable by equality. `target_id` is the contact,
company or deal the request named, or `null` for a collection route and for a **create**, whose
record does not exist yet when the entry is written. `actor_role` is the role the request was
**authorized under**, stored rather than resolved later, so "an admin exported this" stays true after
they are demoted. All three filters are exact matches; a log of ids has no fragments to search for.

`actor_email` is resolved at read time from `users` in the analytics database — the log stores the
id, which is stable and leaves no email behind once an account is closed, but "operator 8f3a1c…" is a
record rather than accountability. It is `null` where the account is gone; the id stays either way.
This is a **deliberate disclosure**: it tells a team admin the addresses of the colleagues who read
this site's contacts, which no other session-reachable route does. Everyone who can appear in the log
holds a role on that admin's own team, since that is what authorized the access being reported.

`admin` rather than `analyst`, and not for the usual reason — no entry carries contact PII. It is
that entries are about the deployment's own *operators*: a log of what each colleague read is
oversight in an administrator's hands and surveillance in a peer's. Reading it is itself recorded.

**Nothing can write here.** There is no update or delete route, and deleting a contact leaves its
entries standing — they name it by id and hold none of its fields, so once the row is gone the
pointer resolves to nothing and there is no personal data left for an erasure request to reach. A log
an operator can clear by deleting the contact is not evidence of anything.

The log is the one CRM table on a retention schedule. `CRM_AUDIT_RETENTION_DAYS` (default **365**)
is enforced by the hourly cron; a value below `1` falls back to the default rather than putting the
cutoff at or after now and wiping the log on every run. It is deliberately longer than
`RAW_RETENTION_DAYS`: raw events are visitors' data and the short window *is* the privacy measure,
while these entries record what operators did with contact data, and an access log that expires
before the misuse it evidences is noticed has protected nobody. Contacts themselves remain on no
schedule at all.

---

## `GET /api/health`

Unauthenticated liveness check. Returns `200` with `{ "ok": true }`.
