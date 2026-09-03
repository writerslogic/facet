// Worker environment bindings. Required bindings come from `wrangler.example.jsonc` through the
// generated worker-configuration.d.ts; this file only describes deliberately optional deployment
// variants, secrets, and application-level variables that cannot be inferred from the template.

import type { Role } from './lib/accounts.js';
import type { DerivedEvent } from './lib/ingest.js';

interface OptionalDeploymentBindings {
	/** Ingest queue: the beacon enqueues a derived (IP-free) event and returns immediately, and a consumer
	 * batches the D1 writes off the hot path. Optional — absent in tests, where ingest runs synchronously. */
	INGEST_QUEUE?: Queue<DerivedEvent>;
	/** Cloudflare native rate-limit binding. Optional: `lib/ratelimit.ts` fails OPEN when it is
	 * unbound, so a production deployment MUST bind it. The test config deliberately omits it. */
	RATE_LIMITER?: RateLimit;
	/** Analytics Engine dataset — the columnar analytical store every accepted event is mirrored into
	 * (see lib/ae.ts). Optional: with the binding removed, the AE writes no-op and D1 is the only store. */
	AE?: AnalyticsEngineDataset;
	/** Explicit opt-in for the best-effort Analytics Engine mirror. D1 remains authoritative. */
	AE_BEST_EFFORT_ENABLED?: string;
	/** Set to "false" only in isolated tests or a deliberate legacy deployment. Production defaults
	 * to validating every public beacon against an existing site's configured domain. */
	COLLECT_VALIDATE_SITE?: string;
	/** Months of hour/day rollup detail kept before `lib/coarsen.ts` folds a month into one `month`
	 * row (string var). Nothing is deleted — coarsening is additive. */
	ROLLUP_DETAIL_MONTHS?: string;
	/** Months after which a `month` rollup row is additionally folded into a `year` row (string var). */
	ROLLUP_MONTHLY_MONTHS?: string;
	/** Cloudflare account id (var) for Analytics Engine SQL-over-HTTP reads. Optional: with either
	 * this or `CF_API_TOKEN` unset, `lib/ae-sql.ts` reports AE unreadable instead of building a URL. */
	CF_ACCOUNT_ID?: string;
	/** Cloudflare API token (Worker secret) for Analytics Engine SQL-over-HTTP reads. */
	CF_API_TOKEN?: string;
	/** Admin bearer token (Worker secret, never a var). Optional because it genuinely can be unset:
	 * `requireAdmin` MUST keep failing closed rather than hashing `undefined` into a match. */
	ADMIN_TOKEN?: string;
	/** HMAC secret (Worker secret) for signing dashboard session tokens. When unset, account auth is
	 * disabled (the /api/auth routes return 503) — the per-site API-key path is unaffected. */
	SESSION_SECRET?: string;
	/** Optional Cloudflare Email Routing sender used for operator magic links and alert email. */
	SEND_EMAIL?: SendEmail;
	/** Verified sender address for dashboard magic links. */
	AUTH_EMAIL_FROM?: string;
	/** Verified sender address for anomaly alerts. */
	ALERT_EMAIL_FROM?: string;
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
	/** Optional https URL (var) serving a JSON array of bot user-agent regex sources. Unset means the
	 * refresh is inert and compiled-in `isbot` is the only source; fetched patterns are ADDITIVE (see
	 * `lib/bots.ts`). https is required because the response becomes regexes that gate what is recorded. */
	FACET_BOT_RULESET_URL?: string;
	/** Optional external SCITT Transparency Service URL (var). When unset, external registration is a no-op. */
	SCITT_URL?: string;
	/** Optional bearer token (Worker secret) for the external SCITT service. */
	SCITT_TOKEN?: string;
	/** CRM database — a separate D1 database, not a table set inside `DB`. It stores only explicitly
	 * materialized pseudonymous contacts; raw operator identifiers and analytics identities do not
	 * cross this physical boundary.
	 *
	 * The separation is load-bearing: D1 cannot join across databases, so a future analytics bridge
	 * cannot become an accidental foreign key or query join. Binding this also changes what the
	 * deployment attests; see `lib/dpv.ts`. */
	CRM_DB?: D1Database;
}

type OptionalGeneratedBinding = 'INGEST_QUEUE' | 'RATE_LIMITER' | 'AE';

/** Runtime environment: generated required bindings plus explicitly optional deployment variants. */
export type Env = Omit<CloudflareBindings, OptionalGeneratedBinding> & OptionalDeploymentBindings;

/** App-wide Hono environment: bindings plus request-scoped variables (set by auth middleware).
 * `userId`/`role` are set only by `requireTeamRole`, the session-only guard — the API-key middlewares
 * leave them undefined, so a handler that reads them cannot be reached by a `clk_` key. */
export type AppEnv = {
	Bindings: Env;
	Variables: { siteId: string; userId?: string; role?: Role };
};
