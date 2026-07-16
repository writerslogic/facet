<!-- Self-hosting guide: deploy the Worker + D1. -->

# Self-hosting

Countless runs entirely on Cloudflare Workers + D1. One Worker serves ingest, the stats
API, the dashboard, and the hourly cron rollups.

## Prerequisites

- **Node.js ≥ 20**
- **pnpm 11** (the repo pins `pnpm@11.12.0`)
- A **Cloudflare account** with `wrangler` authenticated (`wrangler login`)

Clone the repo and install dependencies:

```sh
git clone https://github.com/OWNER/countless.git
cd countless
pnpm install
```

## Deploy

### 1. Create the D1 database

```sh
wrangler d1 create countless
```

This prints a `database_id`. Open `apps/server/wrangler.jsonc` and replace the
placeholder — it ships as `PLACEHOLDER_D1_DATABASE_ID`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "countless",
    "database_id": "PLACEHOLDER_D1_DATABASE_ID", // ← paste your real id here
    "migrations_dir": "migrations"
  }
]
```

### 2. Set the admin token

The admin endpoints (create sites, issue keys) are guarded by a bearer token compared in
constant time. Store it as a Worker secret:

```sh
wrangler secret put ADMIN_TOKEN
```

### 3. Apply migrations

```sh
pnpm --filter @countless/server migrate:remote
```

### 4. Build the dashboard

The Worker serves the built dashboard from `apps/dashboard/dist` as static assets:

```sh
pnpm --filter @countless/dashboard build
```

### 5. Deploy the Worker

```sh
pnpm --filter @countless/server deploy
```

Your Worker now serves the dashboard at its root and the API under `/api`.

## Create a site and API key

Sites and keys are created through the admin API, authenticated with the `ADMIN_TOKEN`
you set above (`Authorization: Bearer <ADMIN_TOKEN>`).

Create a site:

```sh
curl -X POST https://your-deployment.example.com/api/sites \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"My Site","domain":"example.com"}'
```

Response (`201`):

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

Use the returned `site.id` as your `data-site-id` / `siteId` (see [Usage](./usage.md)).

Issue an API key for that site so you can read stats:

```sh
curl -X POST https://your-deployment.example.com/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"site_id":"11111111-1111-4111-8111-111111111111","label":"reporting"}'
```

Response (`201`) — the plaintext `key` is shown **once** and never retrievable again:

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "key": "clk_<64-hex-characters>"
}
```

See the [API reference](./api.md) for the full admin surface (`GET /api/sites`,
`GET /api/keys?site_id=`, `DELETE /api/keys/:id?site_id=`) and the stats endpoint.

## Local development

Apply migrations to the local D1 database, then load the demo seed:

```sh
pnpm --filter @countless/server migrate:local
pnpm --filter @countless/server seed:local
```

`seed:local` inserts a demo site (`Demo` / `demo.local`, id
`11111111-1111-4111-8111-111111111111`) with 30 sample events and a ready-to-use dev API
key. The dev key plaintext is:

```
clk_localdevkey
```

Run the Worker locally:

```sh
pnpm --filter @countless/server dev
```

Then query the local stats API with the dev key:

```sh
curl "http://localhost:8787/api/stats?site_id=11111111-1111-4111-8111-111111111111&start=1704067200000&end=1704672000000" \
  -H "Authorization: Bearer clk_localdevkey"
```

## Retention

Raw events, sessions, and daily salts are purged past a rolling window controlled by the
`RAW_RETENTION_DAYS` var in `apps/server/wrangler.jsonc` (default **90** days). Aggregated
rollups are durable and never deleted. The purge runs on the hourly cron. See the
[privacy model](./privacy.md) for details.
