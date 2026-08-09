<!-- Self-hosting guide: deploy the Worker + D1. -->

# Self-hosting

Facet runs entirely on Cloudflare Workers + D1. One Worker serves ingest, the stats
API, the dashboard, and the hourly cron rollups.

## Prerequisites

- **Node.js ≥ 22** (pnpm 11 requires ≥ 22.13)
- **pnpm 11** (the repo pins `pnpm@11.12.0`)
- A **Cloudflare account** with `wrangler` authenticated (`wrangler login`)

Clone the repo and install dependencies:

```sh
git clone https://github.com/writerslogic/facet.git
cd facet
pnpm install
```

## Deploy

```sh
npx @writerslogic/facet-cli init     # or `facet init` with the CLI installed
```

One command does all of it: creates the D1 database and writes its id into the Worker config,
generates and stores the `ADMIN_TOKEN`, applies migrations, builds the dashboard, deploys, then
creates your first site and issues its API key. It asks only for the hostname, the site domain, and
the site name — each with a default — and confirms before it creates anything. Re-running it resumes
rather than starting over, and `facet doctor` diagnoses an install that has gone sideways.

See the [install guide](./install.md) for the full step list, the flags (`--dry-run`, `--yes`,
`--workers-dev`, `--hostname`, `--new-key`, `--rotate-admin-token`), and the failure table.

The rest of this page is the manual path — the same steps, run by hand.

## Manual deploy

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

`set-db-id` refuses to clobber an already-set real id unless you pass `--force` — a wrong id points a
live deployment at someone else's database. Verify the binding before deploying:

```sh
facet config check --config apps/server/wrangler.jsonc
```

`check` exits nonzero if `database_id` is missing or still the placeholder, so it doubles as
a pre-deploy guard.

### 2. Create the ingest queue

The beacon enqueues events and a consumer batches the D1 writes off the hot path, so the queue must
exist before the deploy binds to it:

```sh
wrangler queues create facet-ingest
wrangler queues create facet-ingest-dlq
```

`facet-ingest-dlq` is the dead-letter queue: a message that still fails after `max_retries` lands
there instead of being dropped. Nothing reads it automatically — it exists so a poisoned message is
inspectable (`wrangler queues consumer add facet-ingest-dlq <worker>` if you want to process it, or
pull messages with the Cloudflare dashboard/API).

Cloudflare Queues requires the **Workers Paid** plan. On the free plan, comment the `queues` block
out of `apps/server/wrangler.jsonc` instead — with no `INGEST_QUEUE` binding the beacon writes to D1
synchronously and everything else is unchanged. (`facet init` offers to do this for you.)

### 3. Apply migrations

```sh
pnpm --filter @facet/server migrate:remote
```

### 4. Build the dashboard

The Worker serves the built dashboard from `apps/dashboard/dist` as static assets:

```sh
pnpm --filter @facet/dashboard build
```

### 5. (Optional) Serve it on your own domain

By default the Worker is reachable on the `*.workers.dev` URL that `deploy` prints, which is enough
to get going. To put it on your own hostname, uncomment the `routes` line in
`apps/server/wrangler.jsonc` and set your own:

```jsonc
"routes": [{ "pattern": "analytics.example.com", "custom_domain": true }],
```

The zone must already be on the Cloudflare account you are deploying to — `custom_domain` provisions
the DNS record and certificate for you, but it cannot create a zone you do not own. Leave the line
commented out if you are not ready; deploying without it changes nothing else.

### 6. Deploy the Worker

```sh
pnpm --filter @facet/server deploy
```

Your Worker now serves the dashboard at its root and the API under `/api`.

### 7. Set the admin token

The admin endpoints (create sites, issue keys) are guarded by a bearer token compared in constant
time. It is a Worker secret, and the Worker has to exist first — so this comes **after** the first
deploy:

```sh
wrangler secret put ADMIN_TOKEN
```

It prompts for the value rather than taking it as an argument, so the token never reaches your shell
history or `ps`. Piping works the same way: `printf '%s' "$TOKEN" | wrangler secret put ADMIN_TOKEN`.
Until it is set, every admin endpoint fails closed with `401`.

Generate one with `openssl rand -hex 32` (or let `facet init` do it — it pipes a fresh 32-byte token
straight to wrangler and never prints it).

## Create a site and API key

`facet init` does this for you. To do it by hand: sites and keys are created through the admin API,
authenticated with the `ADMIN_TOKEN` you set above (`Authorization: Bearer <ADMIN_TOKEN>`).

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

`wrangler dev` reads local secrets from `apps/server/.dev.vars` (gitignored). `facet init` writes the
`ADMIN_TOKEN` it generated there at mode 0600, so the admin endpoints work locally with the same
token as the deployment; load it into your shell without printing it with:

```sh
export FACET_ADMIN_TOKEN=$(grep '^ADMIN_TOKEN=' apps/server/.dev.vars | cut -d= -f2-)
```

Outside a checkout — wiring the Worker into your own repository layout — `facet scaffold --dir <d>`
writes a standalone `wrangler.jsonc` plus a `.dev.vars` with a fresh token, and makes no network
calls.

## Public demo mode

Facet can be turned into a **no-login, read-only demo** in two ways. Both seed a demo profile in
memory, skip the key gate, and show a "Live demo · Deploy your own" pill. Neither affects a normal
self-hosted build — leave the variables unset (the default) and the usual key gate stays.

### Static demo — no backend (GitHub Pages)

This is what the canonical demo at <https://writerslogic.github.io/facet/> runs, and it needs **no
Worker and no database**. The dashboard ships an in-browser mock API (`src/demo/`) that answers every
`/api/*` request from a **fabricated** dataset, so a fictional site's analytics render entirely
client-side — no real data is ever involved. Build it with:

```sh
FACET_BASE=/facet/ VITE_FACET_STATIC_DEMO=1 pnpm --filter @facet/dashboard build
```

`FACET_BASE` sets the asset sub-path (`/facet/` for GitHub *project* Pages; use `/` for a user/org
site or a custom domain). The mock, dataset, and demo profile are dynamically imported, so **none of
this code ships in a normal build**. The `.github/workflows/demo.yml` workflow builds and publishes
this to Pages on every push to `main`.

### Worker-backed demo — real data from a throwaway site

Alternatively, bake a real (throwaway) demo site + read-only key into the build so the demo reads live
aggregates from a Worker:

```sh
VITE_FACET_DEMO_SITE_ID=<demo-site-uuid> \
VITE_FACET_DEMO_API_KEY=clk_<demo-read-key> \
VITE_FACET_DEMO_LABEL="Live demo" \
pnpm --filter @facet/dashboard build
```

The key is **public** (it ships in client JS), so point it at a **throwaway demo site** whose data
you don't mind exposing — never a real property. The key only reads aggregate stats; admin actions
still require the `ADMIN_TOKEN`. In both modes the demo profile is never written to `localStorage`, so
a visitor's own site cleanly supersedes the demo.

## Retention

Raw events, sessions, and daily salts are purged past a rolling window controlled by the
`RAW_RETENTION_DAYS` var in `apps/server/wrangler.jsonc` (default **90** days). Aggregated
rollups are durable and never deleted. The purge runs on the hourly cron. See the
[privacy model](./privacy.md) for details.

Setting this **below 90 disables the Analytics Engine mirror**. Cloudflare keeps an AE data point for
three months with no delete API, so a mirrored copy cannot be purged on your schedule — a shorter
window means the deployment stays D1-only rather than retaining data past what it advertises.

## Analytics Engine reads (optional)

The mirror is best-effort and explicitly opt-in: set `AE_BEST_EFFORT_ENABLED = "true"` under
`vars` in `apps/server/wrangler.jsonc`. Without that flag, D1 remains the only store even when the
dataset is bound. Reading the mirror — which is what `GET /api/stats/breakdown` uses — goes over
Cloudflare's SQL API rather than the binding, so it additionally needs:

```sh
# Var: your 32-hex Cloudflare account id.
npx wrangler deploy --var CF_ACCOUNT_ID:<account-id>
# Secret: an API token with "Account | Account Analytics | Read", and nothing else.
npx wrangler secret put CF_API_TOKEN
```

Leave the flag or either credential unset and every read falls back to D1, which answers the same questions exactly — the
mirror is a scale option, not a dependency. Keep the `dataset` name in `wrangler.jsonc` as
`facet_events`: the binding does not expose its own name at runtime, so reads query that name
directly and a rename silently sends every breakdown back to D1.

## Operations

### Diagnosing an install

```sh
facet doctor
```

Reports what is configured and what is missing — node/wrangler versions, the Cloudflare account, the
D1 binding, the ingest queue, whether `ADMIN_TOKEN` is set on the Worker and whether this machine has
a copy, whether the deployment answers `/api/health`, and which sites exist — then lists the commands
that would fix what it found. It prints no secret values and truncates account/database identifiers,
so the output is safe to paste into a bug report.

### Backups (D1 export)

Facet stores everything in D1. Export a full SQL snapshot with Wrangler:

```sh
wrangler d1 export facet --remote --output facet-backup.sql
```

Store snapshots off-site and on a cadence that matches your tolerance for data loss (e.g. daily).
To restore into a fresh database, create it, apply migrations, then execute the dump:

```sh
wrangler d1 create facet
# set the new database_id (see `facet config set-db-id`), then:
pnpm --filter @facet/server migrate:remote
wrangler d1 execute facet --remote --file facet-backup.sql
```

Aggregated `event_rollups` are durable; raw events/sessions/salts are subject to the retention
window above, so a backup captures only data still inside that window.

### Observability & logs

The Worker emits structured JSON log lines (level, message, request/handler context) with IPs
stripped, and Cloudflare **Workers observability** is enabled in `wrangler.jsonc`
(`observability.enabled = true`). View and query logs in the Cloudflare dashboard or with
`wrangler tail`.

### Anomaly alerting (optional webhook)

The cron job runs anomaly detection over each site's last completed hour and can POST an alert to a
webhook. It is **disabled unless configured** and is never a dependency of ingestion:

```sh
# The endpoint that receives the alerts (a var):
wrangler secret put WEBHOOK_URL      # or set as a var in wrangler.jsonc
# Optional shared secret used to HMAC-sign each delivery:
wrangler secret put WEBHOOK_SECRET
```

Each delivery is a JSON body `{ type: "anomaly", site_id, metric, bucket, direction, z, value,
baseline_mean, summary, delivered_at }`, signed (when a secret is set) with header
`X-Facet-Signature: sha256=<hmac>` — verify it before trusting the payload. Delivery is
time-bounded (5s) and best-effort; the hourly cadence means each anomalous `(site_id, bucket)` is
sent at most once, but consumers should still dedupe on those fields. If you prefer polling, use
`GET /api/stats/anomalies` instead.

## Anomaly alerting

Anomalies are scored on the hourly cron. To be told about them rather than having to open the
dashboard, register a destination per site. These are admin endpoints, so they use `ADMIN_TOKEN`.

```sh
curl -X POST https://your-deployment.example.com/api/alerts \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"site_id":"YOUR_SITE_ID","kind":"webhook",
       "target":"https://hooks.example.com/facet","min_severity":"critical"}'
```

The response carries a signing secret **once and never again** — store it before you close the
terminal, the same way an API key works.

Every webhook delivery is signed twice. `facet-alert-signature: v1=<hmac>` is an HMAC-SHA256 over
`<timestamp>.<body>` using that secret, and is always present. `facet-signature-jws` is a detached
JWS over the RFC 8785 canonical bytes and appears only when `FACET_SIGNING_JWK` is configured (see
below). Verify the HMAC before trusting a payload. The timestamp is bound *into* the MAC, so a
captured delivery cannot be replayed under a new date, and the body carries a `delivery_id` unique
per attempt plus a `dedupe_key` stable per anomaly.

Webhook targets are restricted to prevent the admin API becoming an SSRF primitive: HTTPS only,
port 443 only, no credentials in the URL, and no private, loopback, link-local, CGNAT or
metadata-service address. Redirects are not followed. The target is re-validated immediately before
every delivery, not just at creation, so tightening the policy also covers destinations stored
earlier.

### Email delivery (optional)

Email uses Cloudflare Email Routing and is **off unless you enable it**, because the binding fails
the deploy on a zone that has not set Email Routing up — enabling it by default would break existing
deployments. When the binding or `ALERT_EMAIL_FROM` is absent, an email destination records
`email_unconfigured` and nothing else changes.

To turn it on: enable Email Routing on the zone, verify the destination address, then add to
`apps/server/wrangler.jsonc`:

```jsonc
"send_email": [{ "name": "SEND_EMAIL" }],
"vars": { "ALERT_EMAIL_FROM": "facet@your-domain.example" }
```

> **Note:** `apps/server/wrangler.jsonc` is tracked with git's `skip-worktree` bit so a live
> `database_id` never reaches the repository — the committed copy keeps
> `PLACEHOLDER_D1_DATABASE_ID`. That means local edits to this file are **not staged or committed**.
> Apply the block above to your own working copy; do not clear the bit to commit it, or you will push
> your real database id. Check with `git ls-files -v apps/server/wrangler.jsonc` (a leading `S` means
> the bit is set). `facet init` writes to this file — the database id and the route — which is exactly
> what the bit exists for: the edits stay in your working copy and are never staged.

## Trust & provenance configuration

Facet can sign machine-readable statements about the deployment — its keys, privacy processing, and
build/config state — so third parties can verify what your instance is and does. This is **optional
and off by default**: with no signing key configured, the signed endpoints return `501` / an empty
JWKS and every analytics feature works unchanged. See [Trust & provenance](./trust.md) for what gets
published and how to verify it.

### Signing key

Generate a deployment signing keypair and store the **private** JWK as a Worker secret; the public
half is published automatically at `/.well-known/jwks.json`. Ed25519 is required for the VC 2.0 Data
Integrity credential (`eddsa-jcs-2022`):

```sh
facet keys generate --out signing.jwk        # writes the private JWK (mode 0600)
wrangler secret put FACET_SIGNING_JWK < signing.jwk
rm signing.jwk                                # keep only the Worker secret
```

### Related variables

All optional. Secrets go through `wrangler secret put`; plain vars can live in `wrangler.jsonc`.

| Name | Kind | Purpose |
| --- | --- | --- |
| `FACET_SIGNING_JWK` | secret | Private signing JWK (above). Enables all signed attestations/credentials/exports. |
| `FACET_SECURITY_CONTACT` | var | `security.txt` contact URI. Defaults to the project security mailbox. |
| `FACET_SECURITY_POLICY` | var | `security.txt` policy URL. Defaults to the repo `SECURITY.md`. |
| `FACET_BUILD_ID` | var | Build identifier surfaced in the RATS process-evidence. Defaults to `unknown`. |
| `FACET_GIT_COMMIT` | var | Source commit surfaced in the process-evidence. Defaults to `unknown`. |
| `FACET_WRANGLER_HASH` | var | SHA-256 (hex) of the wrangler config, surfaced in the process-evidence. |
| `SCITT_URL` | var | External SCITT Transparency Service URL. When unset, external registration is a no-op (the local D1-backed MMR log still runs). |
| `SCITT_TOKEN` | secret | Bearer token for the external SCITT service. |

### Hardware-rooted keys

`key-attributes.hardware` in the RATS evidence is a verified, conditional claim: it is `true` only
when a key-attestation, checked against a configured trust anchor, proves the signing key is
hardware-resident. Hold the key in an HSM / cloud-KMS / hardware token and supply its attestation —
see [Trust & provenance → Hardware-rooted signing keys](./trust.md#hardware-rooted-signing-keys). By
default the Worker signs with the `FACET_SIGNING_JWK` software secret and reports honest software
attestation (`hardware:false`).

## Test Worker config

`apps/server/wrangler.test.jsonc` is **generated** from `wrangler.jsonc` by
`apps/server/scripts/gen-test-wrangler.mjs` (run automatically by the server `pretest` script,
so it never drifts). It is identical to `wrangler.jsonc` except the `ai` binding is stripped:
the `vitest-pool-workers` miniflare runtime can't resolve the external AI worker and crashes at
startup. The NL pipeline is instead tested with an injectable stub `LlmRunner`, and
`/api/stats/query` returns `503` when `env.AI` is absent. Edit `wrangler.jsonc` (not the test
file) and regenerate with `pnpm --filter @facet/server gen:test-config`.
