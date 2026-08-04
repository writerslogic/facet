// Worker environment bindings (D1, static assets, rate-limiter, vars, secrets). Single source of truth for `Env`.

import type { Role } from './lib/accounts.js';
import type { DerivedEvent } from './lib/ingest.js';

export interface Env {
	/** D1 database holding sites, events, rollups, salts, and API keys. */
	DB: D1Database;
	/** Ingest queue: the beacon enqueues a derived (IP-free) event and returns immediately, and a consumer
	 * batches the D1 writes off the hot path. Optional — absent in tests, where ingest runs synchronously. */
	INGEST_QUEUE?: Queue<DerivedEvent>;
	/** Static-asset binding serving the built dashboard. */
	ASSETS: Fetcher;
	/** Cloudflare native rate-limit binding. */
	RATE_LIMITER: RateLimit;
	/** Analytics Engine dataset — the columnar analytical store every accepted event is mirrored into
	 * (see lib/ae.ts). Optional: with the binding removed, the AE writes no-op and D1 is the only store. */
	AE?: AnalyticsEngineDataset;
	/** Rolling retention window for raw events, in days (string var). */
	RAW_RETENTION_DAYS: string;
	/** Cloudflare account id (var), used for Analytics Engine SQL-over-HTTP reads. */
	CF_ACCOUNT_ID: string;
	/** Cloudflare API token (Worker secret) for Analytics Engine SQL-over-HTTP reads. */
	CF_API_TOKEN: string;
	/** Admin bearer token (Worker secret, never a var). */
	ADMIN_TOKEN: string;
	/** HMAC secret (Worker secret) for signing dashboard session tokens. When unset, account auth is
	 * disabled (the /api/auth routes return 503) — the per-site API-key path is unaffected. */
	SESSION_SECRET?: string;
	/** Workers AI binding, used to translate natural-language analytics questions. */
	AI: Ai;
	/** Optional anomaly-alert webhook URL (var). When unset, anomaly webhooks are disabled. */
	WEBHOOK_URL?: string;
	/** Optional secret (Worker secret) used to HMAC-sign anomaly webhook payloads. */
	WEBHOOK_SECRET?: string;
	/** YOUR deployment's security.txt contact URI (var), e.g. `mailto:security@example.com`. There is
	 * deliberately no default: until this is set, `/.well-known/security.txt` returns 404 rather than
	 * publishing someone else's address as this deployment's disclosure contact. */
	FACET_SECURITY_CONTACT?: string;
	/** Optional security.txt policy URL (var) — your own disclosure policy. Omitted from the served
	 * file when unset; never defaulted to the upstream project's policy. */
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
	/** CRM database — a SEPARATE D1 database, not a table set inside `DB`. The CRM is an optional
	 * extension holding directly-supplied contact PII, so "excluded" has to mean the tables do not
	 * exist: with this binding absent there is no database, no migration is applied, and every
	 * `/api/crm` route returns 501 `crm_unavailable`.
	 *
	 * The separation is load-bearing, not cosmetic. D1 cannot join across databases, so the
	 * contact→analytics link CANNOT be a foreign key — it must be assembled in the Worker, which
	 * structurally forces it through the consent check in `lib/consent.ts` instead of a join someone
	 * adds later. Binding this also changes what the deployment attests: see `lib/dpv.ts`. */
	CRM_DB?: D1Database;
}

/** App-wide Hono environment: bindings plus request-scoped variables (set by auth middleware).
 * `userId`/`role` are set only by `requireTeamRole`, the session-only guard — the API-key middlewares
 * leave them undefined, so a handler that reads them cannot be reached by a `clk_` key. */
export type AppEnv = {
	Bindings: Env;
	Variables: { siteId: string; userId?: string; role?: Role };
};
