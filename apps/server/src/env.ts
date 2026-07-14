// Worker environment bindings (D1, static assets, rate-limiter, vars, secrets). Single source of truth for `Env`.

export interface Env {
	/** D1 database holding sites, events, rollups, salts, and API keys. */
	DB: D1Database;
	/** Static-asset binding serving the built dashboard. */
	ASSETS: Fetcher;
	/** Cloudflare native rate-limit binding. */
	RATE_LIMITER: RateLimit;
	/** Analytics Engine dataset sink for high-cardinality performance samples. */
	AE: AnalyticsEngineDataset;
	/** Rolling retention window for raw events, in days (string var). */
	RAW_RETENTION_DAYS: string;
	/** Cloudflare account id (var), used for Analytics Engine SQL-over-HTTP reads. */
	CF_ACCOUNT_ID: string;
	/** Cloudflare API token (Worker secret) for Analytics Engine SQL-over-HTTP reads. */
	CF_API_TOKEN: string;
	/** Admin bearer token (Worker secret, never a var). */
	ADMIN_TOKEN: string;
}

/** App-wide Hono environment: bindings plus request-scoped variables (set by auth middleware). */
export type AppEnv = { Bindings: Env; Variables: { siteId: string } };
