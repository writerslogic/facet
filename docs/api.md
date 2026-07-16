<!-- API reference: ingest beacon + stats + admin endpoints. -->

# API reference

All endpoints live under `/api` on your deployment. Times are unix epoch **milliseconds**.

## Authentication

- `POST /api/collect` — **public**, no auth (CORS-open, rate-limited).
- `GET /api/stats` — **API key**: `Authorization: Bearer <clk_...>`.
- `POST /api/sites`, `GET /api/sites`, `POST /api/keys`, `GET /api/keys`,
  `DELETE /api/keys/:id` — **admin token**: `Authorization: Bearer <ADMIN_TOKEN>`.

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
10 each for paths/referrers/events/countries; devices unbounded):

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
  ]
}
```

- `summary.pageviews` counts events with no `name`; `summary.events` counts named events;
  `summary.visitors` is `COUNT(DISTINCT visitor_hash)` over the range (see the
  [privacy model](./privacy.md) for daily-uniques semantics).

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
