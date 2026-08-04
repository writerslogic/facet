// Drizzle schema for the OPTIONAL CRM database (`CRM_DB`) — a physically separate D1 database from
// the analytics one in `schema.ts`. Kept separate so that a deployment without the extension has no
// CRM tables at all, and so that the contact→analytics link cannot be expressed as a foreign key:
// D1 has no cross-database join, so the link is assembled in the Worker and must pass through the
// signed-consent check. `drizzle-kit generate --config drizzle.crm.config.ts` emits ./migrations-crm.
//
// WHAT IS DIFFERENT ABOUT THIS DATA. Everything in `schema.ts` is either aggregate or a salted
// one-way hash. A contact is a named person who handed their details over directly, so this file is
// the deployment's first table of directly-identifying PII. Two consequences are designed in rather
// than deferred:
//   • Contacts are NOT on the raw-event retention schedule (`lib/retention.ts`). A contact is a
//     business record with its own lifecycle; deleting it is an explicit act, not a cron side effect.
//   • No column here caches a derived `visitor_hash`. The ONLY bridge to analytics is
//     `external_user_id`, resolved at read time through an active `identified` consent record. When
//     retention purges that record (or its identity salt), the link severs on its own — nothing here
//     holds a stale copy that would outlive the consent authorizing it.

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Contact lifecycle states. Free-form status strings would make the list filter meaningless. */
export const CONTACT_STATUSES = ['lead', 'active', 'archived'] as const;

/**
 * A person in the CRM. snake_case JS keys throughout, matching the goals/funnels/flags convention in
 * `schema.ts`, so a validated request body maps onto columns without a per-field remap.
 *
 * `external_user_id` is the site's own opaque id for this person — the same value the site passes to
 * `POST /api/consent` and to `/api/event`. It is the join key to `consent_records.external_user_id`
 * in the analytics database and the ONLY thing that can ever tie this row to a visitor hash.
 *
 * `owner_user_id` references `users.id` in the ANALYTICS database (dashboard operators, per the
 * accounts/RBAC tables). There is deliberately no parallel staff table here, and there cannot be a
 * foreign key across the database boundary, so this is validated against `users` in the Worker.
 */
export const contacts = sqliteTable(
	'contacts',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		external_user_id: text('external_user_id'),
		email: text('email'),
		name: text('name'),
		phone: text('phone'),
		company: text('company'),
		title: text('title'),
		status: text('status').notNull().default('lead'),
		source: text('source'),
		notes: text('notes'),
		owner_user_id: text('owner_user_id'),
		created_at: integer('created_at').notNull(),
		updated_at: integer('updated_at').notNull(),
	},
	(t) => [
		index('idx_contacts_site_created').on(t.site_id, t.created_at),
		index('idx_contacts_site_status').on(t.site_id, t.status),
		// SQLite treats NULLs as distinct in a UNIQUE index, so both of these constrain only the rows
		// that actually carry the value: a site cannot hold two contacts with the same email or the
		// same external id, while any number may have neither. The external-id uniqueness is what
		// makes the analytics link deterministic — one contact per identified visitor, per site.
		uniqueIndex('idx_contacts_site_email').on(t.site_id, t.email),
		uniqueIndex('idx_contacts_site_extuser').on(t.site_id, t.external_user_id),
	],
);
