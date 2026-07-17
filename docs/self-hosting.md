<!-- Self-hosting guide: deploy the Worker + D1. -->

# Self-hosting

Facet runs entirely on Cloudflare Workers + D1. One Worker serves ingest, the stats
API, the dashboard, and the hourly cron rollups.

## Prerequisites

- **Node.js ≥ 20**
- **pnpm 11** (the repo pins `pnpm@11.12.0`)
- A **Cloudflare account** with `wrangler` authenticated (`wrangler login`)

Clone the repo and install dependencies:

```sh
git clone https://github.com/dcondrey/facet.git
cd facet
pnpm install
```

## Deploy

### 1. Create the D1 database

```sh
wrangler d1 create facet
```

This prints a `database_id`. Write it into `apps/server/wrangler.jsonc` — which ships with
the placeholder `PLACEHOLDER_D1_DATABASE_ID` — with the CLI (this does a targeted replace
that preserves the file's comments and unrelated config):

```sh
facet config set-db-id --id <database_id> --config apps/server/wrangler.jsonc
```

`set-db-id` refuses to clobber an already-set real id unless you pass `--force`. Verify the
binding before deploying:

```sh
facet config check --config apps/server/wrangler.jsonc
```

`check` exits nonzero if `database_id` is missing or still the placeholder, so it doubles as
a pre-deploy guard.

### 2. Set the admin token

The admin endpoints (create sites, issue keys) are guarded by a bearer token compared in
constant time. Store it as a Worker secret:

```sh
wrangler secret put ADMIN_TOKEN
```

### 3. Apply migrations

```sh
pnpm --filter @facet/server migrate:remote
```

### 4. Build the dashboard

The Worker serves the built dashboard from `apps/dashboard/dist` as static assets:

```sh
pnpm --filter @facet/dashboard build
```

### 5. Deploy the Worker

```sh
pnpm --filter @facet/server deploy
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

### With the CLI

The `facet` CLI wraps the same admin API. Point it at your deployment with `--host` /
`--admin-token` (or export `FACET_HOST` / `FACET_ADMIN_TOKEN`); the admin token is only ever
sent in the `Authorization` header and is never printed:

```sh
export FACET_HOST=https://your-deployment.example.com
export FACET_ADMIN_TOKEN=<ADMIN_TOKEN>

facet sites create --name "My Site" --domain example.com
facet sites list
facet keys issue --site <site-uuid> --label reporting   # prints the clk_… key ONCE
facet keys list --site <site-uuid>
facet keys revoke --id <key-uuid> --site <site-uuid>
```

The same command groups manage `goals`, `funnels`, and `experiments`. Add `--json` to any
command for machine-readable output.

## Local development

Apply migrations to the local D1 database, then load the demo seed:

```sh
pnpm --filter @facet/server migrate:local
pnpm --filter @facet/server seed:local
```

`seed:local` inserts a demo site (`Demo` / `demo.local`, id
`11111111-1111-4111-8111-111111111111`) with 30 sample events and a ready-to-use dev API
key. The dev key plaintext is:

```
clk_localdevkey
```

Run the Worker locally:

```sh
pnpm --filter @facet/server dev
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

## Test Worker config

`apps/server/wrangler.test.jsonc` is **generated** from `wrangler.jsonc` by
`apps/server/scripts/gen-test-wrangler.mjs` (run automatically by the server `pretest` script,
so it never drifts). It is identical to `wrangler.jsonc` except the `ai` binding is stripped:
the `vitest-pool-workers` miniflare runtime can't resolve the external AI worker and crashes at
startup. The NL pipeline is instead tested with an injectable stub `LlmRunner`, and
`/api/stats/query` returns `503` when `env.AI` is absent. Edit `wrangler.jsonc` (not the test
file) and regenerate with `pnpm --filter @facet/server gen:test-config`.
