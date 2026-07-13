// Worker environment bindings (D1, static assets, rate-limiter, vars, secrets). Single source of truth for `Env`.

export interface Env {
	/** D1 database holding sites, events, rollups, salts, and API keys. */
	DB: D1Database;
	/** Static-asset binding serving the built dashboard. */
	ASSETS: Fetcher;
	/** Cloudflare native rate-limit binding. */
	RATE_LIMITER: RateLimit;
	/** Rolling retention window for raw events, in days (string var). */
	RAW_RETENTION_DAYS: string;
	/** Admin bearer token (Worker secret, never a var). */
	ADMIN_TOKEN: string;
}
