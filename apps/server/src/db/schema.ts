// Drizzle schema for D1 — the typed single source of truth for tables and columns. Query
// helpers infer their types from here; `drizzle-kit generate` emits the SQL migrations from it.

import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
	(t) => [primaryKey({ columns: [t.siteId, t.hostname, t.bucketStart, t.interval] })],
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
