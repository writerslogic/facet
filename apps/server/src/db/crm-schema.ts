// Privacy-first CRM schema for the optional, physically separate `CRM_DB` D1 database.
//
// Analytics identities never appear here. A contact exists only after explicit operator
// materialization, and the operator's identifier is stored only as a site-scoped keyed digest.
// Every child key carries `site_id`; composite foreign keys make tenant isolation and erasure
// properties of the database rather than conventions in route handlers.

import { sql } from 'drizzle-orm';
import {
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const CONTACT_LIFECYCLE_STATES = ['lead', 'active', 'churned'] as const;

export const CONTACT_LEGAL_BASES = [
	'consent',
	'contract',
	'legitimate_interest',
	'legal_obligation',
	'vital_interest',
	'public_task',
] as const;

export const CRM_TAG_COLOR_TOKENS = [
	'slate',
	'violet',
	'blue',
	'cyan',
	'green',
	'amber',
	'orange',
	'rose',
] as const;

export const crmContacts = sqliteTable(
	'crm_contacts',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		/** HMAC-SHA-256, encoded as lowercase hex. Raw operator identifiers never reach D1. */
		external_id_hash: text('external_id_hash').notNull(),
		/** Optional pseudonymous display label. It is never an identity or an analytics join key. */
		alias: text('alias'),
		lifecycle_state: text('lifecycle_state').notNull().default('lead'),
		legal_basis: text('legal_basis').notNull(),
		origin_source: text('origin_source').notNull(),
		/** Operator source-event time, distinct from Facet's materialization time. */
		origin_occurred_at: integer('origin_occurred_at').notNull(),
		consent_captured_at: integer('consent_captured_at'),
		score: integer('score').notNull().default(0),
		created_at: integer('created_at').notNull(),
		updated_at: integer('updated_at').notNull(),
	},
	(t) => [
		// Composite anchors are required for tenant-safe child foreign keys.
		uniqueIndex('uq_crm_contacts_site_id').on(t.site_id, t.id),
		uniqueIndex('uq_crm_contacts_site_external_id').on(t.site_id, t.external_id_hash),
		index('idx_crm_contacts_site_created_id').on(t.site_id, t.created_at, t.id),
		index('idx_crm_contacts_site_score_id').on(t.site_id, t.score, t.id),
		index('idx_crm_contacts_site_lifecycle_id').on(t.site_id, t.lifecycle_state, t.id),
		check(
			'ck_crm_contacts_external_id_hash',
			sql`length(${t.external_id_hash}) = 64 AND ${t.external_id_hash} = lower(${t.external_id_hash}) AND ${t.external_id_hash} NOT GLOB '*[^0-9a-f]*'`,
		),
		check(
			'ck_crm_contacts_alias',
			sql`${t.alias} IS NULL OR length(${t.alias}) BETWEEN 1 AND 160`,
		),
		check(
			'ck_crm_contacts_lifecycle_state',
			sql`${t.lifecycle_state} IN ('lead', 'active', 'churned')`,
		),
		check(
			'ck_crm_contacts_legal_basis',
			sql`${t.legal_basis} IN ('consent', 'contract', 'legitimate_interest', 'legal_obligation', 'vital_interest', 'public_task')`,
		),
		check(
			'ck_crm_contacts_origin_source',
			sql`length(${t.origin_source}) BETWEEN 1 AND 64 AND ${t.origin_source} = lower(${t.origin_source}) AND ${t.origin_source} NOT GLOB '*[^a-z0-9_.-]*'`,
		),
		check(
			'ck_crm_contacts_timestamps',
			sql`${t.origin_occurred_at} >= 0 AND ${t.created_at} >= 0 AND ${t.updated_at} >= ${t.created_at}`,
		),
		check(
			'ck_crm_contacts_consent',
			sql`(${t.consent_captured_at} IS NULL OR ${t.consent_captured_at} >= 0) AND (${t.legal_basis} <> 'consent' OR ${t.consent_captured_at} IS NOT NULL)`,
		),
	],
);

export const crmTags = sqliteTable(
	'crm_tags',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		normalized_name: text('normalized_name').notNull(),
		display_name: text('display_name').notNull(),
		color_token: text('color_token').notNull(),
		created_at: integer('created_at').notNull(),
	},
	(t) => [
		uniqueIndex('uq_crm_tags_site_id').on(t.site_id, t.id),
		uniqueIndex('uq_crm_tags_site_normalized_name').on(t.site_id, t.normalized_name),
		check(
			'ck_crm_tags_normalized_name',
			sql`length(${t.normalized_name}) BETWEEN 1 AND 64 AND ${t.normalized_name} = lower(${t.normalized_name}) AND ${t.normalized_name} NOT GLOB '*[^a-z0-9-]*'`,
		),
		check('ck_crm_tags_display_name', sql`length(${t.display_name}) BETWEEN 1 AND 80`),
		check(
			'ck_crm_tags_color_token',
			sql`${t.color_token} IN ('slate', 'violet', 'blue', 'cyan', 'green', 'amber', 'orange', 'rose')`,
		),
		check('ck_crm_tags_created_at', sql`${t.created_at} >= 0`),
	],
);

export const crmContactTags = sqliteTable(
	'crm_contact_tags',
	{
		site_id: text('site_id').notNull(),
		contact_id: text('contact_id').notNull(),
		tag_id: text('tag_id').notNull(),
		created_at: integer('created_at').notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.site_id, t.contact_id, t.tag_id] }),
		foreignKey({
			name: 'fk_crm_contact_tags_contact',
			columns: [t.site_id, t.contact_id],
			foreignColumns: [crmContacts.site_id, crmContacts.id],
		}).onDelete('cascade'),
		foreignKey({
			name: 'fk_crm_contact_tags_tag',
			columns: [t.site_id, t.tag_id],
			foreignColumns: [crmTags.site_id, crmTags.id],
		}).onDelete('cascade'),
		index('idx_crm_contact_tags_site_tag_contact').on(t.site_id, t.tag_id, t.contact_id),
		check('ck_crm_contact_tags_created_at', sql`${t.created_at} >= 0`),
	],
);

export const crmContactEvents = sqliteTable(
	'crm_contact_events',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		contact_id: text('contact_id').notNull(),
		event_type: text('event_type').notNull(),
		payload: text('payload', { mode: 'json' }),
		occurred_at: integer('occurred_at').notNull(),
	},
	(t) => [
		foreignKey({
			name: 'fk_crm_contact_events_contact',
			columns: [t.site_id, t.contact_id],
			foreignColumns: [crmContacts.site_id, crmContacts.id],
		}).onDelete('cascade'),
		index('idx_crm_events_contact_occurred_id').on(
			t.site_id,
			t.contact_id,
			t.occurred_at,
			t.id,
		),
		check(
			'ck_crm_contact_events_type',
			sql`length(${t.event_type}) BETWEEN 1 AND 64 AND ${t.event_type} = lower(${t.event_type}) AND ${t.event_type} NOT GLOB '*[^a-z0-9_.-]*'`,
		),
		check(
			'ck_crm_contact_events_payload',
			sql`${t.payload} IS NULL OR (json_valid(${t.payload}) AND length(${t.payload}) <= 4096)`,
		),
		check('ck_crm_contact_events_occurred_at', sql`${t.occurred_at} >= 0`),
	],
);

export const crmScoreLedger = sqliteTable(
	'crm_score_ledger',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		contact_id: text('contact_id').notNull(),
		previous_score: integer('previous_score').notNull(),
		delta: integer('delta').notNull(),
		next_score: integer('next_score').notNull(),
		reason: text('reason').notNull(),
		rule_id: text('rule_id'),
		occurred_at: integer('occurred_at').notNull(),
	},
	(t) => [
		foreignKey({
			name: 'fk_crm_score_ledger_contact',
			columns: [t.site_id, t.contact_id],
			foreignColumns: [crmContacts.site_id, crmContacts.id],
		}).onDelete('cascade'),
		index('idx_crm_score_contact_occurred_id').on(t.site_id, t.contact_id, t.occurred_at, t.id),
		check(
			'ck_crm_score_ledger_arithmetic',
			sql`${t.next_score} = ${t.previous_score} + ${t.delta}`,
		),
		check('ck_crm_score_ledger_delta', sql`${t.delta} <> 0`),
		check(
			'ck_crm_score_ledger_reason',
			sql`length(${t.reason}) BETWEEN 1 AND 64 AND ${t.reason} = lower(${t.reason}) AND ${t.reason} NOT GLOB '*[^a-z0-9_.-]*'`,
		),
		check(
			'ck_crm_score_ledger_rule_id',
			sql`${t.rule_id} IS NULL OR length(${t.rule_id}) BETWEEN 1 AND 64`,
		),
		check('ck_crm_score_ledger_occurred_at', sql`${t.occurred_at} >= 0`),
	],
);
