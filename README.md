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

<!-- TODO(T031): replace OWNER/REPO once the GitHub repo exists. -->
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/countless)

## Why Countless

- **Single deploy.** One Worker serves ingest, the stats API, the dashboard, and cron rollups.
- **No database to run.** State lives in Cloudflare D1.
- **Cookieless & GDPR-friendly.** Privacy-safe uniques via `SHA-256(ip + user_agent + daily_salt + site_id)`.
- **Free, self-issued API keys.** Query your own stats programmatically.
- **umami-compatible client.** `window.umami.track(name, props)` and auto-pageviews work unchanged.
- **Unlimited sites.** Multi-site is first-class.

## Packages

| Path | Published as | Purpose |
| --- | --- | --- |
| `apps/server` | — | Cloudflare Worker: ingest + stats API + cron rollups + D1 schema |
| `apps/dashboard` | — | React 19 + Vite dashboard, served as static assets by the Worker |
| `packages/client` | [`countless`](https://www.npmjs.com/package/countless) | Browser tracking snippet (zero deps, umami shim) |
| `packages/cli` | [`countless`](https://www.npmjs.com/package/countless) (`npx countless`) | `init` / `migrate` / `stats` CLI |
| `packages/shared` | — | Shared TypeScript types |

## Quick start

```sh
pnpm install
pnpm typecheck
```

See [`docs/`](./docs) for self-hosting, the privacy model, and the API reference, and
[`DEVPLAN.md`](./DEVPLAN.md) for the full v1 build plan.

## License

[MIT](./LICENSE)
