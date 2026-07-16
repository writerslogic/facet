<!-- API reference: ingest beacon + stats + admin endpoints. -->

# API reference

All endpoints live under `/api` on your deployment. Times are unix epoch **milliseconds**.

## Authentication

- `POST /api/collect` — **public**, no auth (CORS-open, rate-limited).
- `GET /api/stats`, `GET /api/stats/sessions`, `GET /api/stats/channels`,
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
  ]
}
```

- `summary.pageviews` counts events with no `name`; `summary.events` counts named events;
  `summary.visitors` is `COUNT(DISTINCT visitor_hash)` over the range (see the
  [privacy model](./privacy.md) for daily-uniques semantics).

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
  }
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
  ]
}
```

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
