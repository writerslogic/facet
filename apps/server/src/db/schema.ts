// Drizzle schema for D1 — the typed single source of truth for tables and columns. Query
// helpers infer their types from here; `drizzle-kit generate` emits the SQL migrations from it.

import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const sites = sqliteTable('sites', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	domain: text('domain').notNull(),
	createdAt: integer('created_at').notNull(),
});

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
	},
	(t) => [
		index('idx_events_site_created_name').on(t.siteId, t.createdAt, t.name),
		index('idx_events_site_host_created').on(t.siteId, t.hostname, t.createdAt),
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
