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
	/** Workers AI binding, used to translate natural-language analytics questions. */
	AI: Ai;
	/** Optional anomaly-alert webhook URL (var). When unset, anomaly webhooks are disabled. */
	WEBHOOK_URL?: string;
	/** Optional secret (Worker secret) used to HMAC-sign anomaly webhook payloads. */
	WEBHOOK_SECRET?: string;
	/** Optional security.txt contact URI (var). Defaults to the project security mailbox. */
	FACET_SECURITY_CONTACT?: string;
	/** Optional security.txt policy URL (var). Defaults to the repo SECURITY.md. */
	FACET_SECURITY_POLICY?: string;
	/** Optional deployment signing key as a private JWK string (Worker secret, Ed25519 preferred).
	 * When unset, all signing/attestation features are inert and the deployment behaves as before. */
	FACET_SIGNING_JWK?: string;
	/** Optional build identifier (var) surfaced in attestations/evidence. Defaults to `unknown`. */
	FACET_BUILD_ID?: string;
	/** Optional source commit (var) surfaced in attestations/evidence. Defaults to `unknown`. */
	FACET_GIT_COMMIT?: string;
	/** Optional SHA-256 (hex) of the wrangler config (var), surfaced in RATS process evidence. */
	FACET_WRANGLER_HASH?: string;
	/** Optional external SCITT Transparency Service URL (var). When unset, external registration is a no-op. */
	SCITT_URL?: string;
	/** Optional bearer token (Worker secret) for the external SCITT service. */
	SCITT_TOKEN?: string;
}

/** App-wide Hono environment: bindings plus request-scoped variables (set by auth middleware). */
export type AppEnv = { Bindings: Env; Variables: { siteId: string } };
