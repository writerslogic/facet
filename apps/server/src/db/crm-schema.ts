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
//     `crm_audit_log` is the one table here that IS on a schedule, on its own longer window, because
//     it is the one that grows without anybody deciding to add a row.
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

/** Deal lifecycle. `won`/`lost` are terminal — a pipeline aggregate excludes them from "open" by this
 * set, not by a separate flag, so the two can never disagree about which stages are still moving. */
export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;

/**
 * A sales opportunity. A deal linked to `contact_id` makes that person's data include
 * `pd:Transactional` (see `lib/dpv.ts`), same as `company_id` on a contact adding `pd:CurrentEmployment`.
 * `ON DELETE` is handled in the Worker: `deleteCompany`/`deleteContact` null the reference here rather
 * than cascade, the same "unlink, don't destroy" precedent as `contacts.company_id`. `value`/`currency`
 * are both-or-neither (wire schema) so a pipeline total is never summed across an unnamed currency.
 */
export const deals = sqliteTable(
	'deals',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		name: text('name').notNull(),
		company_id: text('company_id').references(() => companies.id),
		contact_id: text('contact_id').references(() => contacts.id),
		stage: text('stage').notNull().default('lead'),
		/** Cents. Null means no estimate yet, distinct from a deal genuinely worth zero. */
		value: integer('value'),
		/** ISO 4217, uppercase. Required exactly when `value` is set. */
		currency: text('currency'),
		expected_close_date: integer('expected_close_date'),
		notes: text('notes'),
		owner_user_id: text('owner_user_id'),
		created_at: integer('created_at').notNull(),
		updated_at: integer('updated_at').notNull(),
	},
	(t) => [
		index('idx_deals_site_created').on(t.site_id, t.created_at),
		index('idx_deals_site_stage').on(t.site_id, t.stage),
		// Covers both directions, same reason as `idx_contacts_site_company`: listing one company's or
		// contact's deals, and finding every deal to unlink when that row is deleted.
		index('idx_deals_site_company').on(t.site_id, t.company_id),
		index('idx_deals_site_contact').on(t.site_id, t.contact_id),
	],
);

/**
 * Who touched the contact store, what they touched, and when. One row per authorized `/api/crm`
 * request, written BEFORE the handler runs.
 *
 * WHY IT IS HERE rather than in the analytics database. Every row names a `target_id`, which is a
 * pointer into this database's PII, and the analytics database is deliberately free of anything that
 * resolves to a named person. Keeping the log beside the data it describes also means an unbound
 * deployment has no audit table for the same reason it has no contacts — the extension does not
 * exist — and that the log and the row it records are one database apart rather than two, which is
 * the only reason the two writes can be reasoned about at all.
 *
 * WHAT IT DELIBERATELY DOES NOT HOLD is any contact FIELD. It records that contact `x` was read, not
 * what reading it returned, so the log is a record about the OPERATOR and only a pointer to the
 * subject. That is what makes it safe to outlive the contact: once the row is deleted the pointer
 * resolves to nothing, so an erasure request does not have to reach in here — and must not, since a
 * log an operator can clear by deleting the contact is not evidence of anything. Nothing in the API
 * updates or deletes these rows; only the retention cron does.
 *
 * `actor_role` is stored rather than resolved at read time because it is the role the request was
 * AUTHORIZED under. Roles change; "an admin exported this" has to stay true after they are demoted.
 */
export const crmAuditLog = sqliteTable(
	'crm_audit_log',
	{
		id: text('id').primaryKey(),
		site_id: text('site_id').notNull(),
		/** `users.id` in the ANALYTICS database, so no foreign key is possible — the same cross-database
		 * limitation as `contacts.owner_user_id`, and the same reason it is validated in the Worker. */
		actor_user_id: text('actor_user_id').notNull(),
		actor_role: text('actor_role').notNull(),
		/** One of `CRM_AUDIT_ACTIONS`. A closed set, so the log is filterable by equality. */
		action: text('action').notNull(),
		/** The contact or company the request named, or NULL for a collection-level action. */
		target_id: text('target_id'),
		occurred_at: integer('occurred_at').notNull(),
	},
	(t) => [
		// The default view: one site's log, newest first. Also what the actor and action filters scan.
		index('idx_crm_audit_site_time').on(t.site_id, t.occurred_at),
		// "Everything anyone did to this contact" — the question an erasure or subject-access request
		// asks, and the one a site-and-time scan answers worst.
		index('idx_crm_audit_site_target').on(t.site_id, t.target_id),
		// Retention purges across every site at once, so it needs the timestamp leading. Same shape and
		// same reason as `idx_identity_salts_window_end` in the analytics schema.
		index('idx_crm_audit_occurred').on(t.occurred_at),
	],
);
