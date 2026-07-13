// Worker environment bindings (D1, static assets, vars). Single source of truth for `Env`.

export interface Env {
	/** D1 database holding sites, events, rollups, salts, and API keys. */
	DB: D1Database;
	/** Static-asset binding serving the built dashboard. */
	ASSETS: Fetcher;
	/** Rolling retention window for raw events, in days (string var). */
	RAW_RETENTION_DAYS: string;
}
