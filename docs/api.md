<!-- API reference: ingest beacon + stats endpoints. Filled in by T032. -->

# API reference

> Stub — expanded in T032.

## `POST /api/collect`

Public beacon. No auth, rate-limited. Body:

```json
{ "site_id": "…", "hostname": "example.com", "path": "/pricing", "referrer": "", "name": null, "props": null }
```

Returns `202 Accepted`.

## `GET /api/stats`

API-key authenticated (`Authorization: Bearer <key>`). Query params: `site_id`, `hostname?`,
`start`, `end`, `interval?`. Returns summary, series, and top paths/referrers/events.
