<!-- Self-hosting guide: deploy the Worker + D1. Filled in by T032. -->

# Self-hosting

> Stub — expanded in T032.

1. Click **Deploy to Cloudflare**, or clone and run `pnpm install`.
2. Create the D1 database and apply migrations: `pnpm --filter @countless/server migrate:remote`.
3. `pnpm --filter @countless/dashboard build` then `pnpm --filter @countless/server deploy`.
