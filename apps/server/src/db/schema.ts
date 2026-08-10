// Drizzle schema for D1 — the typed single source of truth for tables and columns. Query
// helpers infer their types from here; `drizzle-kit generate` emits the SQL migrations from it.

import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const sites = sqliteTable('sites', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	domain: text('domain').notNull(),
	createdAt: integer('created_at').notNull(),
	// Owning team (RBAC). Nullable + additive: a site with no team behaves as today (API-key access only).
	teamId: text('team_id'),
});

// ── Accounts & RBAC (Phase 4). Dashboard operators — NOT tracked visitors — so this is orthogonal to
//    the cookieless/no-cross-session-identity visitor model. Passwordless: no password column ever. ──

/**
 * A dashboard user, identified by email. No password is stored — auth is magic-link + passkeys.
 *
 * `session_epoch` is what makes a session revocable. Session tokens are HMAC-signed and carry their
 * own expiry, so nothing about the token itself can be withdrawn once it is out: logging out clears a
 * cookie in one browser and leaves a copied token valid for the rest of its 30 days. Every token
 * carries the epoch it was signed at, and a session resolves only while that still equals this
 * column — so incrementing it ends every outstanding session for this person at once, without a
 * session table and without a lookup per token beyond the one the RBAC path already performs.
 *
 * A counter rather than a timestamp: two revocations in the same millisecond are two revocations, and
 * a clock that moves backwards must not resurrect a session.
 */
export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	email: text('email').notNull().unique(),
	name: text('name'),
	createdAt: integer('created_at').notNull(),
	lastLogin: integer('last_login'),
	sessionEpoch: integer('session_epoch').notNull().default(0),
});

/** A team that owns sites; members access them through a role. */
export const teams = sqliteTable('teams', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	createdAt: integer('created_at').notNull(),
});

/** A user's role on a team: owner ▸ admin ▸ analyst ▸ viewer (see ROLE_RANK in lib/accounts). */
export const memberships = sqliteTable(
	'memberships',
	{
		teamId: text('team_id').notNull(),
		userId: text('user_id').notNull(),
		role: text('role').notNull(),
		createdAt: integer('created_at').notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.teamId, t.userId] }),
		index('idx_memberships_user').on(t.userId),
	],
);

/** Single-use, short-lived magic-link tokens. Only the SHA-256 of the secret is stored; the raw token
 * lives only in the emailed link. `used_at` enforces single use. */
export const authTokens = sqliteTable(
	'auth_tokens',
	{
		id: text('id').primaryKey(),
		tokenHash: text('token_hash').notNull(),
		email: text('email').notNull(),
		expiresAt: integer('expires_at').notNull(),
		usedAt: integer('used_at'),
		createdAt: integer('created_at').notNull(),
	},
	(t) => [index('idx_auth_tokens_email').on(t.email)],
);

export const events = sqliteTable(
	'events',
	{
		id: text('id').primaryKey(),
		siteId: text('site_id').notNull(),
		hostname: text('hostname').notNull(),
		path: text('path').notNull(),
		referrer: text('referrer').notNull().default(''),
		name: text('name'),
		props: text('props'),
		visitorHash: text('visitor_hash').notNull(),
		country: text('country'),
		device: text('device'),
		createdAt: integer('created_at').notNull(),
		utmSource: text('utm_source'),
		utmMedium: text('utm_medium'),
		utmCampaign: text('utm_campaign'),
		channel: text('channel'),
		// Private-by-construction segmentation dimensions (all nullable + additive; a null is "unknown"):
		// geo/network edge-derived from request.cf (IP never stored), browser/os/form-factor from UA client
		// hints (UA fallback, families not versions), language from the primary Accept-Language subtag, and
		// screen tier/orientation/DPR class coarsened ON-DEVICE by the tracker (raw resolution never sent).
		browser: text('browser'),
		os: text('os'),
		formFactor: text('form_factor'),
		region: text('region'),
		city: text('city'),
		timezone: text('timezone'),
		network: text('network'),
		connection: text('connection'),
		language: text('language'),
		screenTier: text('screen_tier'),
		orientation: text('orientation'),
		dprClass: text('dpr_class'),
		// Ecommerce: monetary value + ISO currency, extracted at ingest from a valued event's
		// `props.revenue`/`props.currency` (e.g. track('purchase', { revenue: 49.99, currency: 'USD' })).
		// REAL is fine for analytics aggregates (SUM/AVG); not ledger-grade accounting.
		value: real('value'),
		currency: text('currency'),
	},
	(t) => [
		index('idx_events_site_created_name').on(t.siteId, t.createdAt, t.name),
		index('idx_events_site_host_created').on(t.siteId, t.hostname, t.createdAt),
		// Covering indexes for the higher-cardinality segmentation breakdowns: the (site, time-range,
		// dimension) shape lets each top-N read range-scan + group from the index rather than the table.
		index('idx_events_site_created_browser').on(t.siteId, t.createdAt, t.browser),
		index('idx_events_site_created_os').on(t.siteId, t.createdAt, t.os),
		index('idx_events_site_created_region').on(t.siteId, t.createdAt, t.region),
		index('idx_events_site_created_network').on(t.siteId, t.createdAt, t.network),
		// Every other index leads with created_at, so a visitor_hash filter (conversions.ts's
		// per-session EXISTS, experiments.ts's per-exposure EXISTS, contact-analytics.ts's
		// unranged IN-list) fell back to a full table scan. visitor_hash leads here since
		// contact-analytics.ts's lookup carries no time bound at all.
		index('idx_events_site_visitor_created').on(t.siteId, t.visitorHash, t.createdAt),
	],
);

export const eventRollups = sqliteTable(
	'event_rollups',
	{
		siteId: text('site_id').notNull(),
		hostname: text('hostname').notNull(),
		bucketStart: integer('bucket_start').notNull(),
		interval: text('interval').notNull(),
		pageviews: integer('pageviews').notNull().default(0),
		events: integer('events').notNull().default(0),
		visitors: integer('visitors').notNull().default(0),
	},
	(t) => [
		primaryKey({
			columns: [t.siteId, t.hostname, t.bucketStart, t.interval],
		}),
	],
);

export const sessions = sqliteTable(
	'sessions',
	{
		siteId: text('site_id').notNull(),
		visitorHash: text('visitor_hash').notNull(),
		dayKey: text('day_key').notNull(),
		firstSeen: integer('first_seen').notNull(),
	},
	(t) => [primaryKey({ columns: [t.siteId, t.visitorHash, t.dayKey] })],
);

export const eventSessions = sqliteTable(
	'event_sessions',
	{
		id: text('id').primaryKey(),
		siteId: text('site_id').notNull(),
		visitorHash: text('visitor_hash').notNull(),
		dayKey: text('day_key').notNull(),
		startedAt: integer('started_at').notNull(),
		endedAt: integer('ended_at').notNull(),
		entryPath: text('entry_path').notNull(),
		exitPath: text('exit_path').notNull(),
		channel: text('channel'),
		pageviews: integer('pageviews').notNull().default(0),
		events: integer('events').notNull().default(0),
		durationMs: integer('duration_ms').notNull().default(0),
		isBounce: integer('is_bounce').notNull().default(0),
	},
	(t) => [index('idx_sessions_site_started').on(t.siteId, t.startedAt)],
);

export const salts = sqliteTable('salts', {
	dayKey: text('day_key').primaryKey(),
	salt: text('salt').notNull(),
	createdAt: integer('created_at').notNull(),
});

export const apiKeys = sqliteTable(
	'api_keys',
	{
		id: text('id').primaryKey(),
		siteId: text('site_id').notNull(),
		keyHash: text('key_hash').notNull().unique(),
		label: text('label'),
		createdAt: integer('created_at').notNull(),
		lastUsed: integer('last_used'),
	},
	(t) => [index('idx_apikeys_site').on(t.siteId)],
);

/** One row per (key, granted scope) — normalized out of `apiKeys.scopes`'s former comma-separated
 * string so a scope is a real value, not a substring match. `scope` stays fixed-allowlist text
 * (validated in app code against `API_KEY_SCOPES`) rather than a foreign key to a scopes table:
 * the allowlist is a closed set that changes with a code deploy, not runtime data. */
export const apiKeyScopes = sqliteTable(
	'api_key_scopes',
	{
		apiKeyId: text('api_key_id').notNull(),
		scope: text('scope').notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.apiKeyId, t.scope] }),
		index('idx_apikeyscopes_key').on(t.apiKeyId),
	],
);

/** Durable cron heartbeat. Readiness and operators can distinguish "the Worker answers" from
 * "rollups/retention are actually succeeding" without scraping ephemeral logs. */
export const scheduledJobRuns = sqliteTable('scheduled_job_runs', {
	name: text('name').primaryKey(),
	lastSuccessAt: integer('last_success_at'),
	lastFailureAt: integer('last_failure_at'),
	lastError: text('last_error'),
});

// goals/funnels use snake_case JS keys for the columns crudRouter and its POST body touch (`id`,
// `site_id`, `created_at`, and `match_value`) so the validated body inserts verbatim; this satisfies
// the crudRouter `CrudTable` contract without a per-field remap.
export const goals = sqliteTable(
	'goals',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		name: text('name').notNull(),
		type: text('type').notNull(),
		match_value: text('match_value').notNull(),
		created_at: integer('created_at').notNull(),
	},
	(t) => [index('idx_goals_site').on(t.site_id)],
);

export const funnels = sqliteTable(
	'funnels',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		name: text('name').notNull(),
		steps: text('steps').notNull(),
		created_at: integer('created_at').notNull(),
	},
	(t) => [index('idx_funnels_site').on(t.site_id)],
);

// experiments store their `variants` as a JSON TEXT column (mirrors funnels.steps): the validated
// array is stringified on insert and parsed back on read. `active` is a 0/1 integer flag.
export const experiments = sqliteTable(
	'experiments',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		name: text('name').notNull(),
		flag_key: text('flag_key').notNull(),
		variants: text('variants').notNull(),
		active: integer('active').notNull().default(1),
		created_at: integer('created_at').notNull(),
	},
	(t) => [index('idx_experiments_site').on(t.site_id)],
);

// Feature flags. `variants` and `rules` are JSON TEXT columns (same convention as funnels.steps /
// experiments.variants): bounded arrays stringified on write, parsed on read — no separate rules
// table, since rules are always read and written together with their flag. `salt` is server-minted
// once at creation and NEVER changed (rotating it would rebucket every visitor); `version` bumps on
// every mutation so the public `/active` ETag invalidates on a kill-switch. `(site_id, flag_key)` is
// unique so a client can address a flag by its stable key within a site.
export const flags = sqliteTable(
	'flags',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		flag_key: text('flag_key').notNull(),
		name: text('name').notNull(),
		type: text('type').notNull(),
		enabled: integer('enabled').notNull().default(1),
		default_variant: text('default_variant').notNull(),
		variants: text('variants').notNull(),
		rules: text('rules').notNull().default('[]'),
		salt: text('salt').notNull(),
		rollout_seed: integer('rollout_seed').notNull().default(0),
		version: integer('version').notNull().default(1),
		created_at: integer('created_at').notNull(),
		updated_at: integer('updated_at').notNull(),
	},
	(t) => [
		index('idx_flags_site').on(t.site_id),
		uniqueIndex('idx_flags_site_key').on(t.site_id, t.flag_key),
	],
);

// Append-only Merkle Mountain Range over finalized event_rollups (transparency log). `mmr_nodes`
// holds the linear node array (index → 32-byte hash, hex). No PII: leaves commit aggregate rollup
// rows, never raw events. Populated on the hourly cron only when a deployment signing key is set.
export const mmrNodes = sqliteTable('mmr_nodes', {
	nodeIndex: integer('node_index').primaryKey(),
	hash: text('hash').notNull(),
});

// Maps each logged rollup to its MMR leaf node index (for inclusion proofs) and dedupes appends.
export const mmrLeaves = sqliteTable('mmr_leaves', {
	leafNo: integer('leaf_no').primaryKey(),
	nodeIndex: integer('node_index').notNull(),
	rollupKey: text('rollup_key').notNull().unique(),
	leafHash: text('leaf_hash').notNull(),
});

// Signed tree heads: the tree size, bagged root (hex), timestamp, and the signed checkpoint JSON.
export const mmrCheckpoints = sqliteTable('mmr_checkpoints', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	treeSize: integer('tree_size').notNull(),
	root: text('root').notNull(),
	createdAt: integer('created_at').notNull(),
	signed: text('signed').notNull(),
});

// Local SCITT Transparency-Service double: an append-only registration log of Signed Statement
// hashes. The server rebuilds an MMR over these hashes to issue an inclusion Receipt. No PII — a
// statement hash commits an attestation about the deployment/dataset. Operating a production
// Transparency Service is a deployment concern, not a shipped Facet service.
export const scittLog = sqliteTable('scitt_log', {
	entryId: integer('entry_id').primaryKey({ autoIncrement: true }),
	statementHash: text('statement_hash').notNull(),
	registeredAt: integer('registered_at').notNull(),
});

// The SCITT log's own MMR, persisted incrementally — same shape as `mmr_nodes`/`mmr_leaves` above but
// a SEPARATE tree (a different log entirely; node indices are not comparable across the two).
export const scittMmrNodes = sqliteTable('scitt_mmr_nodes', {
	nodeIndex: integer('node_index').primaryKey(),
	hash: text('hash').notNull(),
});

// Maps each registered statement to its MMR leaf node index (for inclusion proofs). `leafNo` IS the
// receipt's `entryId` — a 0-based, contiguous sequence number. `scitt_log.entry_id` is NOT used for
// this: SQLite AUTOINCREMENT never reuses an id after a rolled-back insert, so it can carry gaps that
// a receipt's "zero-based registration sequence number" must not.
export const scittMmrLeaves = sqliteTable('scitt_mmr_leaves', {
	leafNo: integer('leaf_no').primaryKey(),
	nodeIndex: integer('node_index').notNull(),
});

// Identity spectrum (U2). All three tables are additive; nothing existing changes, so a site with no
// `site_config` row behaves byte-for-byte as today (Tier 0, daily-rotating anonymous hash via the
// legacy `salts` table). Absence of a row is the default everywhere.
export const siteConfig = sqliteTable('site_config', {
	site_id: text('site_id').primaryKey(),
	tier: text('tier').notNull().default('anonymous'), // anonymous | pseudonymous | identified
	salt_window: text('salt_window').notNull().default('day'), // day | week | month
	updated_at: integer('updated_at').notNull(),
});

// Per-scope secret salts for windows wider than a day. Tier 0/day keeps using the legacy `salts`
// table untouched. `window_end` is the ms timestamp at which this window closes; retention purges a
// salt only once its ENTIRE window has aged out (`window_end < cutoff`), so a salt always outlives
// every event that could reference it (no live event ever points at a purged salt).
export const identitySalts = sqliteTable(
	'identity_salts',
	{
		scope: text('scope').primaryKey(), // `${siteId}:${window}:${windowKey}`
		salt: text('salt').notNull(),
		window: text('window').notNull(),
		window_end: integer('window_end').notNull(),
		created_at: integer('created_at').notNull(),
	},
	(t) => [index('idx_identity_salts_window_end').on(t.window_end)],
);

// Signed consent records — the authorization token for Tier 1/2 elevation. The `statement` column
// holds the full PII-free SignedStatement JSON (claims are the derived hash + tier + window, never
// ip/ua/raw uid). `external_user_id` stores the raw site-supplied uid at rest ONLY to support
// uid-scoped revocation; it is retention/erasure-bound and log-scrubbed like ip/uid.
export const consentRecords = sqliteTable(
	'consent_records',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		visitor_hash: text('visitor_hash').notNull(),
		tier: text('tier').notNull(),
		external_user_id: text('external_user_id'),
		salt_window: text('salt_window').notNull(),
		window_key: text('window_key').notNull(),
		gpc_at_grant: integer('gpc_at_grant').notNull().default(0),
		granted_at: integer('granted_at').notNull(),
		expires_at: integer('expires_at'),
		revoked_at: integer('revoked_at'),
		statement: text('statement').notNull(),
	},
	(t) => [
		index('idx_consent_site_visitor').on(t.site_id, t.visitor_hash, t.tier),
		index('idx_consent_site_extuser').on(t.site_id, t.external_user_id),
	],
);

// Alerting. Both tables are additive: a deployment with no rows behaves exactly as before, and the
// alert cron job short-circuits on an empty `alert_destinations`. snake_case JS keys match the
// goals/funnels convention so a validated admin body inserts without a per-field remap.

/** Where a site's anomaly alerts are sent. `target` is an https URL (webhook) or a mailbox (email);
 * `secret` is the per-destination HMAC key minted at creation and shown to the operator exactly
 * once. It is stored in the clear because signing requires the key material itself — unlike an API
 * key, a one-way hash cannot produce a MAC. It is never returned by the list endpoint. */
export const alertDestinations = sqliteTable(
	'alert_destinations',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		name: text('name').notNull(),
		type: text('type').notNull(), // webhook | email
		target: text('target').notNull(),
		min_severity: text('min_severity').notNull().default('warning'), // info | warning | critical
		secret: text('secret'),
		enabled: integer('enabled').notNull().default(1),
		created_at: integer('created_at').notNull(),
	},
	(t) => [index('idx_alert_destinations_site').on(t.site_id)],
);

/** One row per (destination, anomaly) — the persisted fact that an alert was claimed, so the same
 * anomaly can never be alerted twice. The UNIQUE (destination_id, dedupe_key) index is the dedupe:
 * a row is claimed by an INSERT ... ON CONFLICT DO NOTHING *before* delivery is attempted, so a
 * crash mid-delivery, an overlapping cron, or a re-detection of the same hour next run all collide
 * on it. `attempts` bounds retries of a delivery that never confirmed; `status` records the outcome
 * so a failing endpoint is visible rather than silent. */
export const alertDeliveries = sqliteTable(
	'alert_deliveries',
	{
		id: text('id').primaryKey(),
		destination_id: text('destination_id').notNull(),
		site_id: text('site_id').notNull(),
		dedupe_key: text('dedupe_key').notNull(),
		severity: text('severity').notNull(),
		status: text('status').notNull(), // pending | delivered | failed
		attempts: integer('attempts').notNull().default(0),
		last_error: text('last_error'),
		created_at: integer('created_at').notNull(),
		updated_at: integer('updated_at').notNull(),
	},
	(t) => [
		uniqueIndex('idx_alert_deliveries_dedupe').on(t.destination_id, t.dedupe_key),
		index('idx_alert_deliveries_site').on(t.site_id, t.created_at),
	],
);
