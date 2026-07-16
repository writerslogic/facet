<!-- Countless: privacy-first, Cloudflare-native web analytics. Project landing README. -->

# Countless

Privacy-first, **Cloudflare-native** web analytics that runs 100% on Cloudflare Workers + D1.
No external database, no long-running server. Deploy with a single `wrangler deploy`.

Countless is the [umami](https://umami.is) / [Plausible](https://plausible.io) alternative for
people who want analytics that live entirely on the Cloudflare edge. It is cookieless and
GDPR-friendly: unique visitors are counted with a daily-rotating, salted `SHA-256` hash and
**raw IP addresses are never stored**. The client is a drop-in for umami — existing sites
migrate by swapping a single script tag.

## Deploy to Cloudflare

<!-- Replace OWNER with your GitHub org/user; OWNER/countless is a documented placeholder. -->
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/countless)

## Why Countless

- **Single deploy.** One Worker serves ingest, the stats API, the dashboard, and cron rollups.
- **No database to run.** State lives in Cloudflare D1.
- **Cookieless & GDPR-friendly.** Privacy-safe uniques via `SHA-256(ip + user_agent + daily_salt + site_id)`.
- **Free, self-issued API keys.** Query your own stats programmatically.
- **umami-compatible client.** `window.umami.track(name, props)`, auto-pageviews, SPA navigation, UTM capture, and form-submission tracking work out of the box.
- **Sessions & engagement.** Bounce rate, pages/session, and average visit duration, materialized hourly from raw events.
- **Traffic channels.** Automatic direct / referral / organic / social / paid / email classification from referrer + UTM.
- **Goals, conversions & funnels.** Define goals and multi-step funnels; get conversion rates and in-order funnel drop-off.
- **A/B experiments & feature flags.** Privacy-first, client-side variant assignment; two-proportion significance testing in the dashboard.
- **Anomaly detection & autopsy.** Automatic z-score detection with a plain-language root-cause summary (largest-contributing segment).
- **Ask in plain English.** Natural-language queries over your stats via Workers AI (translated to a constrained, safe query intent).
- **Ad-block-resilient.** First-party `POST /api/event` server-to-server ingest — no client script to block.
- **Unlimited sites.** Multi-site is first-class.

## Packages

| Path | Published as | Purpose |
| --- | --- | --- |
| `apps/server` | — | Cloudflare Worker: ingest + stats API + cron rollups + D1 schema |
| `apps/dashboard` | — | React 19 + Vite dashboard, served as static assets by the Worker |
| `packages/client` | [`countless`](https://www.npmjs.com/package/countless) | Browser tracking snippet (zero deps, umami shim) |
| `packages/cli` | [`countless-cli`](https://www.npmjs.com/package/countless-cli) (`npx countless-cli`) | `init` / `migrate` / `stats` CLI |
| `packages/shared` | — | Shared TypeScript types |

## Quick start

```sh
pnpm install
pnpm typecheck
```

To deploy to your own Cloudflare account, see [`docs/self-hosting.md`](./docs/self-hosting.md).

## Create a site & API key

Sites and keys are created through the admin API, authenticated with your `ADMIN_TOKEN`:

```sh
# Create a site (returns { "site": { "id": "…", … } }):
curl -X POST https://your-deployment.example.com/api/sites \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"My Site","domain":"example.com"}'

# Issue an API key for it (the plaintext key is shown once):
curl -X POST https://your-deployment.example.com/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"site_id":"<SITE_ID>","label":"reporting"}'
```

Use the site `id` as your `data-site-id`, and the returned `clk_…` key for `GET /api/stats`.

See [`docs/`](./docs) for [usage](./docs/usage.md), [self-hosting](./docs/self-hosting.md),
the [privacy model](./docs/privacy.md), and the [API reference](./docs/api.md), and
[`DEVPLAN.md`](./DEVPLAN.md) for the full v1 build plan.

## License

[MIT](./LICENSE)
