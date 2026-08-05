// Drizzle schema for the OPTIONAL CRM database (`CRM_DB`) — a physically separate D1 database from
// the analytics one in `schema.ts`. Kept separate so that a deployment without the extension has no
// CRM tables at all, and so that the contact→analytics link cannot be expressed as a foreign key:
// D1 has no cross-database join, so the link is assembled in the Worker and must pass through the
// signed-consent check. `drizzle-kit generate --config drizzle.crm.config.ts` emits ./migrations-crm.
//
// WHAT IS DIFFERENT ABOUT THIS DATA. Everything in `schema.ts` is either aggregate or a salted
// one-way hash. A contact is a named person who handed their details over directly, so this file is
// the deployment's first table of directly-identifying PII. `companies` is the exception within the
// exception — an organization is a legal person, not a human — but it is here rather than in the
// analytics database because it exists only to be linked from `contacts`. Two consequences are
// designed in rather than deferred:
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
 * An organization. Unlike a contact this is NOT personal data: it is a legal person, and a name, a
 * domain and a note about a company are not about an identifiable human. What it does do is make a
 * contact's employer a structured attribute rather than something typed into a box, which is why
 * `lib/dpv.ts` names `pd:CurrentEmployment` once this exists.
 *
 * `(site_id, name)` is unique as stored, so two identically-named companies on one site are a
 * data-entry mistake rather than two records. It is an exact match — company names are displayed as
 * typed and lowercasing them for a case-insensitive index would corrupt the display value — so
 * `domain`, which IS normalised, is the case-insensitive identity key.
 */
export const companies = sqliteTable(
	'companies',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		name: text('name').notNull(),
		domain: text('domain'),
		status: text('status').notNull().default('lead'),
		notes: text('notes'),
		owner_user_id: text('owner_user_id'),
		created_at: integer('created_at').notNull(),
		updated_at: integer('updated_at').notNull(),
	},
	(t) => [
		index('idx_companies_site_created').on(t.site_id, t.created_at),
		index('idx_companies_site_status').on(t.site_id, t.status),
		uniqueIndex('idx_companies_site_name').on(t.site_id, t.name),
		// NULLs are distinct in a SQLite UNIQUE index, so any number of companies may have no domain
		// while no two may share one.
		uniqueIndex('idx_companies_site_domain').on(t.site_id, t.domain),
	],
);

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
 *
 * `company` and `company_id` are the same fact — where this person works — recorded two ways, and
 * exactly one of them answers at a time. `company_id` is the structured link and wins; `company` is
 * the free text an operator typed for a company that has no record here, and it is what a read
 * coalesces to when nothing is linked. Writing one clears the other, so "which company" never has two
 * answers. This IS a real foreign key, unlike the contact→analytics link and unlike `owner_user_id`,
 * because `companies` lives in THIS database: the separation that forbids the other two is about the
 * analytics boundary specifically, not a blanket aversion to constraints.
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
		company_id: text('company_id').references(() => companies.id),
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
		// Covers both directions of the link: listing one company's contacts, and finding every
		// contact to unlink when that company is deleted.
		index('idx_contacts_site_company').on(t.site_id, t.company_id),
		// SQLite treats NULLs as distinct in a UNIQUE index, so both of these constrain only the rows
		// that actually carry the value: a site cannot hold two contacts with the same email or the
		// same external id, while any number may have neither. The external-id uniqueness is what
		// makes the analytics link deterministic — one contact per identified visitor, per site.
		uniqueIndex('idx_contacts_site_email').on(t.site_id, t.email),
		uniqueIndex('idx_contacts_site_extuser').on(t.site_id, t.external_user_id),
	],
);
