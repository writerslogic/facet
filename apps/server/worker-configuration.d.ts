// Generated ambient types for Cloudflare Worker bindings.
// Matches the bindings declared in wrangler.jsonc.

interface RateLimit {
	limit(opts: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
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
