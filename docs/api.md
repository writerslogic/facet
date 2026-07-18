<!-- API reference: ingest beacon + stats + admin endpoints. -->

# API reference

All endpoints live under `/api` on your deployment. Times are unix epoch **milliseconds**.

## Authentication

- `POST /api/collect` — **public**, no auth (CORS-open, rate-limited).
- `POST /api/event` — **API key**: first-party server-to-server ingest (`Authorization: Bearer <clk_...>`).
- `GET /api/experiments/active` — **public**: client-facing feature-flag config.
- `GET /api/stats/anomalies`, `GET /api/stats/experiments`, `GET /api/stats/experiment`,
  `POST /api/stats/query` — **API key**.
- `GET /api/stats`, `GET /api/stats/sessions`, `GET /api/stats/channels`,
  `GET /api/stats/interactions`, `GET /api/stats/realtime`, `GET /api/stats/export`,
  `GET /api/stats/conversions`, `GET /api/stats/goals`, `GET /api/stats/funnels`,
  `GET /api/funnels/:id/report` — **API key**: `Authorization: Bearer <clk_...>`
  (site-scoped; a key that does not own the requested `site_id` gets `403 site_mismatch`).
- `POST /api/sites`, `GET /api/sites`, `POST /api/keys`, `GET /api/keys`,
  `DELETE /api/keys/:id`, and goal/funnel CRUD (`POST`/`GET`/`DELETE /api/goals`,
  `POST`/`GET`/`DELETE /api/funnels`) — **admin token**: `Authorization: Bearer <ADMIN_TOKEN>`.

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

## `POST /api/collect`

Public ingest beacon. CORS allows any origin (`POST` / `OPTIONS`, `content-type` header,
preflight cached 24h). Rate-limited by client IP. Request bodies over **8192 bytes** are
rejected with `413 payload_too_large` before parsing. Bot user-agents are silently dropped
(the request still returns `202` but no event is written). On success, returns **`202`**
with an empty body.

A request carrying the [Global Privacy Control](https://globalprivacycontrol.org/) header
`Sec-GPC: 1` is treated as an opt-out: it returns `202` but no event is written and no visitor
hash is derived. This mirrors the client-side opt-out and holds for direct callers too.

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
- **Responses:** `202` (empty) on accept, bot-drop, or a `Sec-GPC: 1` opt-out; `400 validation_failed`; `401 invalid_api_key`.

```sh
curl -X POST https://your-deployment.example.com/api/event \
  -H "Authorization: Bearer clk_..." \
  -H "content-type: application/json" \
  -d '{"hostname":"shop.example.com","path":"/checkout","name":"purchase",
       "props":{"amount":42},"ip":"203.0.113.9","user_agent":"Mozilla/5.0 ..."}'
```

---

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

## Well-known documents

Facet serves these documents directly from the Worker (not the static-asset binding), each with the
correct content type:

| Path | Purpose |
| --- | --- |
| `/.well-known/security.txt` | RFC 9116 disclosure contact (Contact, Expires, Policy, Canonical). |
| `/.well-known/jwks.json` | The deployment's public signing key(s) as a JWK Set. Empty (`{"keys":[]}`) when signing is unconfigured. |

These endpoints are public and unauthenticated.

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

## Experiments & feature flags

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

---

## `GET /api/health`

Unauthenticated liveness check. Returns `200` with `{ "ok": true }`.
