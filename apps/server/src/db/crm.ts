// Typed access to the OPTIONAL CRM database. Mirrors db/queries.ts for `DB`, over a different
// binding and a different schema — route handlers call these helpers rather than writing SQL, and
// nothing outside this file touches `env.CRM_DB`.
//
// Every read and write here is scoped by `site_id`, always taken from the authenticated request and
// never from a body, so a session with a role on one site cannot reach another site's contacts even
// by guessing a contact id. That covers the contact→company link too: the foreign key proves the
// company row exists, not that it belongs to the caller's site, so the site predicate is the check
// and the constraint is only the backstop.

import { normalizeCompanyDomain } from '@facet/shared';
import { type SQL, and, desc, eq, isNotNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../env.js';
import { ApiError } from '../lib/http.js';
import * as crmSchema from './crm-schema.js';

/**
 * The CRM binding, or the canonical 501. Unbound is not an error state — it is the default, and it
 * means this deployment has no CRM database at all. 501 rather than 404 follows the deployment-gated
 * precedent already in the codebase (`signing_unavailable`, `ai_unavailable`): the route exists in
 * the build, this deployment just does not implement it.
 */
export function requireCrmDb(env: Env): D1Database {
	if (!env.CRM_DB) {
		throw new ApiError(
			'crm_unavailable',
			501,
			'the CRM extension is not enabled on this deployment',
		);
	}
	return env.CRM_DB;
}

/** Gate a whole router on the CRM binding, so an unbound deployment answers uniformly — including on
 * paths that do not exist — instead of leaking the route table through differing statuses. */
export const requireCrm: MiddlewareHandler<AppEnv> = async (c, next) => {
	requireCrmDb(c.env);
	return next();
};

/** Build a schema-bound Drizzle client over the CRM binding. Deliberately not exported: every CRM
 * query goes through a named helper in this file, so `site_id` scoping cannot be forgotten at a
 * call site. */
function crmDb(binding: D1Database) {
	return drizzle(binding, { schema: crmSchema });
}

/** A contact as read. Column names are the wire names; there is no separate mapping layer. `company`
 * is the one field that is not a raw column — see `CONTACT_COLUMNS`. */
export type Contact = typeof crmSchema.contacts.$inferSelect;

/** A company as stored. */
export type Company = typeof crmSchema.companies.$inferSelect;

/** The fields a caller may set. `id`/`site_id`/`created_at`/`updated_at` are server-owned. */
export interface ContactInput {
	external_user_id?: string | null;
	email?: string | null;
	name?: string | null;
	phone?: string | null;
	company?: string | null;
	company_id?: string | null;
	title?: string | null;
	status?: string;
	source?: string | null;
	notes?: string | null;
	owner_user_id?: string | null;
}

/** The fields a caller may set on a company. */
export interface CompanyInput {
	name?: string | null;
	domain?: string | null;
	status?: string;
	notes?: string | null;
	owner_user_id?: string | null;
}

/**
 * Where a contact works: the linked company's name, falling back to the free text only when nothing
 * is linked.
 *
 * Deliberately NOT `.as('company')`. An aliased SQL expression emits its bare identifier when it
 * appears in a predicate, and `"company"` is also a real column on `contacts` — which always wins
 * over a result alias. A search built on the aliased form therefore compiles, runs, and silently
 * filters on the raw column instead of the coalesce, so every linked contact goes missing from its
 * own company's search results while the query looks perfectly correct.
 */
const COMPANY_LABEL = sql<
	string | null
>`coalesce(${crmSchema.companies.name}, ${crmSchema.contacts.company})`;

/**
 * What a contact read returns. Every column verbatim except `company`, which resolves to the linked
 * company's name and falls back to the free text only when nothing is linked.
 *
 * Resolving rather than caching is the point: the alternative is copying `companies.name` into
 * `contacts.company` at link time, which then has to be kept in sync on every rename and is wrong in
 * between. `company_id` is returned alongside so a caller can still tell a link from a label.
 */
const CONTACT_COLUMNS = {
	id: crmSchema.contacts.id,
	site_id: crmSchema.contacts.site_id,
	external_user_id: crmSchema.contacts.external_user_id,
	email: crmSchema.contacts.email,
	name: crmSchema.contacts.name,
	phone: crmSchema.contacts.phone,
	company: COMPANY_LABEL,
	company_id: crmSchema.contacts.company_id,
	title: crmSchema.contacts.title,
	status: crmSchema.contacts.status,
	source: crmSchema.contacts.source,
	notes: crmSchema.contacts.notes,
	owner_user_id: crmSchema.contacts.owner_user_id,
	created_at: crmSchema.contacts.created_at,
	updated_at: crmSchema.contacts.updated_at,
};

/** Scoped by site as well as by id — the foreign key already guarantees the company exists, but not
 * that it belongs to the same site, and a name crossing that boundary would be a leak rather than a
 * missing value. */
const COMPANY_JOIN = and(
	eq(crmSchema.contacts.company_id, crmSchema.companies.id),
	eq(crmSchema.companies.site_id, crmSchema.contacts.site_id),
);

/** Contacts joined to their company, in the resolved read shape. */
function contactQuery(client: ReturnType<typeof crmDb>) {
	return client
		.select(CONTACT_COLUMNS)
		.from(crmSchema.contacts)
		.leftJoin(crmSchema.companies, COMPANY_JOIN);
}

/** The same join under a `count(*)`. A `q` filter can reference the joined company name, so the total
 * has to be counted over the join or it answers a different question from the page it describes. */
function contactCountQuery(client: ReturnType<typeof crmDb>) {
	return client
		.select({ n: sql<number>`count(*)` })
		.from(crmSchema.contacts)
		.leftJoin(crmSchema.companies, COMPANY_JOIN);
}

/** Normalize an email for storage. Lowercased so `(site_id, email)` uniqueness is not defeated by
 * case, which would otherwise let the same person exist twice and split their consent linkage. */
function normalizeEmail(email: string | null | undefined): string | null {
	const trimmed = email?.trim().toLowerCase();
	return trimmed ? trimmed : null;
}

/**
 * The text of a unique-constraint violation, or null for any other failure.
 *
 * Drizzle wraps driver errors (`DrizzleQueryError` carrying the D1 error as `cause`), and how deeply
 * it nests them is a detail of the ORM version, not a contract. Walking the `cause` chain means a
 * drizzle upgrade that adds or removes a wrapper turns a 409 into a 409, not into a 500 — which is
 * exactly what a single-level `err.message` check did.
 */
export function uniqueConstraintText(err: unknown): string | null {
	let current: unknown = err;
	// Bounded, so a self-referential `cause` cannot spin here.
	for (let depth = 0; depth < 5; depth++) {
		if (!(current instanceof Error)) return null;
		if (/UNIQUE constraint failed/i.test(current.message)) return current.message;
		current = current.cause;
	}
	return null;
}

/** Blank strings arriving from a form mean "unset", not "the empty string" — an empty `email` stored
 * as `''` would collide with every other blank one under the unique index. */
function orNull(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * A bounded, literal substring match over one column or expression.
 *
 * The LIKE metacharacters are escaped so a `%` in the search box means a literal percent sign rather
 * than "match everything" — without this, `q=%` scans the whole table.
 *
 * The `ESCAPE` clause is not optional decoration: SQLite ignores backslash escapes entirely unless it
 * is present, so `\%` would be read as a literal backslash followed by the wildcard. A prefixed term
 * with no ESCAPE clause happens to match nothing (no name contains a backslash), which looks like it
 * works while quietly making `%` unsearchable.
 */
function likeMatch(target: SQLiteColumn | SQL<string | null>, q: string): SQL {
	const term = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
	return sql`${target} LIKE ${term} ESCAPE '\\'`;
}

/**
 * Resolve a company id to a company on this site, or raise the 400 a bad link deserves.
 *
 * Without this, an unknown id would reach the foreign key and come back as an opaque 500, and an id
 * belonging to ANOTHER site would satisfy the foreign key perfectly — the constraint knows the row
 * exists, not that the caller is allowed to see it. Site scoping is this function's real job; the
 * constraint is the backstop, not the check.
 */
async function resolveCompany(
	client: ReturnType<typeof crmDb>,
	siteId: string,
	companyId: string,
): Promise<Company> {
	const company = await client
		.select()
		.from(crmSchema.companies)
		.where(and(eq(crmSchema.companies.site_id, siteId), eq(crmSchema.companies.id, companyId)))
		.get();
	if (!company) {
		throw new ApiError(
			'unknown_company',
			400,
			'company_id does not match a company on this site',
		);
	}
	return company;
}

export async function insertContact(
	binding: D1Database,
	siteId: string,
	input: ContactInput,
	now: number,
): Promise<Contact> {
	const client = crmDb(binding);
	const companyId = orNull(input.company_id);
	const company = companyId ? await resolveCompany(client, siteId, companyId) : null;
	const row = {
		id: crypto.randomUUID(),
		site_id: siteId,
		external_user_id: orNull(input.external_user_id),
		email: normalizeEmail(input.email),
		name: orNull(input.name),
		phone: orNull(input.phone),
		// The wire schema rejects both as non-empty, so at most one of these is a value.
		company: company ? null : orNull(input.company),
		company_id: company?.id ?? null,
		title: orNull(input.title),
		status: input.status ?? 'lead',
		source: orNull(input.source),
		notes: orNull(input.notes),
		owner_user_id: orNull(input.owner_user_id),
		created_at: now,
		updated_at: now,
	};
	await client.insert(crmSchema.contacts).values(row);
	return { ...row, company: company ? company.name : row.company };
}

export function getContact(
	binding: D1Database,
	siteId: string,
	id: string,
): Promise<Contact | undefined> {
	return contactQuery(crmDb(binding))
		.where(and(eq(crmSchema.contacts.site_id, siteId), eq(crmSchema.contacts.id, id)))
		.get();
}

export interface ListContactsOptions {
	status?: string;
	/** Substring match over name/email/company. Bounded by the caller's schema. */
	q?: string;
	limit: number;
	offset: number;
}

export async function listContacts(
	binding: D1Database,
	siteId: string,
	opts: ListContactsOptions,
): Promise<{ contacts: Contact[]; total: number }> {
	const filters = [eq(crmSchema.contacts.site_id, siteId)];
	if (opts.status) {
		filters.push(eq(crmSchema.contacts.status, opts.status));
	}
	if (opts.q) {
		const anyField = or(
			likeMatch(crmSchema.contacts.name, opts.q),
			likeMatch(crmSchema.contacts.email, opts.q),
			// The RESOLVED company, not the raw column. Linking a contact nulls its free text, so
			// searching only `contacts.company` would make every linked contact unfindable by the very
			// company it was just attached to.
			likeMatch(COMPANY_LABEL, opts.q),
		);
		if (anyField) {
			filters.push(anyField);
		}
	}
	const where = and(...filters);
	const client = crmDb(binding);
	const [contacts, totalRow] = await Promise.all([
		contactQuery(client)
			.where(where)
			.orderBy(desc(crmSchema.contacts.created_at))
			.limit(opts.limit)
			.offset(opts.offset),
		contactCountQuery(client).where(where).get(),
	]);
	return { contacts, total: totalRow?.n ?? 0 };
}

/** Every contact at one company, newest first. Uses the same resolved shape as the contact list, so
 * a company's roster and the contact list report the same rows. */
export async function listCompanyContacts(
	binding: D1Database,
	siteId: string,
	companyId: string,
	opts: { limit: number; offset: number },
): Promise<{ contacts: Contact[]; total: number }> {
	const where = and(
		eq(crmSchema.contacts.site_id, siteId),
		eq(crmSchema.contacts.company_id, companyId),
	);
	const client = crmDb(binding);
	const [contacts, totalRow] = await Promise.all([
		contactQuery(client)
			.where(where)
			.orderBy(desc(crmSchema.contacts.created_at))
			.limit(opts.limit)
			.offset(opts.offset),
		client.select({ n: sql<number>`count(*)` }).from(crmSchema.contacts).where(where).get(),
	]);
	return { contacts, total: totalRow?.n ?? 0 };
}

/**
 * Write whichever of `company` / `company_id` the caller actually supplied, keeping the invariant
 * that only one of them ever holds a value.
 *
 * A NON-EMPTY write to either clears the other: a caller who types a company name is stating a new
 * employer, and leaving the old link in place would make their write appear to do nothing, since
 * reads resolve the link in preference to the text. An explicitly BLANK write clears only the field
 * it names — "I have no free text for this" is not the same statement as "unlink this contact".
 */
async function setCompanyFields(
	client: ReturnType<typeof crmDb>,
	siteId: string,
	input: ContactInput,
	set: Record<string, string | number | null>,
): Promise<void> {
	const wantsLink = 'company_id' in input ? orNull(input.company_id) : null;
	const wantsText = 'company' in input ? orNull(input.company) : null;
	if (wantsLink) {
		set.company_id = (await resolveCompany(client, siteId, wantsLink)).id;
		set.company = null;
		return;
	}
	if (wantsText) {
		set.company = wantsText;
		set.company_id = null;
		return;
	}
	if ('company' in input) set.company = null;
	if ('company_id' in input) set.company_id = null;
}

/** Apply a partial update. Only keys actually present in `input` are written, so a PATCH that omits
 * a field leaves it alone rather than nulling it. Returns the updated row in the resolved read
 * shape, or undefined if the contact does not exist on this site. */
export async function updateContact(
	binding: D1Database,
	siteId: string,
	id: string,
	input: ContactInput,
	now: number,
): Promise<Contact | undefined> {
	const client = crmDb(binding);
	const set: Record<string, string | number | null> = { updated_at: now };
	if ('external_user_id' in input) set.external_user_id = orNull(input.external_user_id);
	if ('email' in input) set.email = normalizeEmail(input.email);
	if ('name' in input) set.name = orNull(input.name);
	if ('phone' in input) set.phone = orNull(input.phone);
	await setCompanyFields(client, siteId, input, set);
	if ('title' in input) set.title = orNull(input.title);
	if ('status' in input && input.status) set.status = input.status;
	if ('source' in input) set.source = orNull(input.source);
	if ('notes' in input) set.notes = orNull(input.notes);
	if ('owner_user_id' in input) set.owner_user_id = orNull(input.owner_user_id);
	const updated = await client
		.update(crmSchema.contacts)
		.set(set)
		.where(and(eq(crmSchema.contacts.site_id, siteId), eq(crmSchema.contacts.id, id)))
		.returning({ id: crmSchema.contacts.id });
	// `returning()` gives raw columns; the caller is promised the resolved shape, so re-read through
	// the join rather than hand-assembling a second version of it here.
	return updated[0] ? getContact(binding, siteId, id) : undefined;
}

/** Really delete a contact — the row is gone, not flagged. A tombstone carrying an email is still
 * that person's personal data, so an erasure request cannot be answered with one. Returns the
 * deleted row so the caller can act on its `external_user_id` before it is lost. */
export async function deleteContact(
	binding: D1Database,
	siteId: string,
	id: string,
): Promise<Contact | undefined> {
	const deleted = await crmDb(binding)
		.delete(crmSchema.contacts)
		.where(and(eq(crmSchema.contacts.site_id, siteId), eq(crmSchema.contacts.id, id)))
		.returning();
	return deleted[0];
}

export async function insertCompany(
	binding: D1Database,
	siteId: string,
	input: CompanyInput,
	now: number,
): Promise<Company> {
	const row = {
		id: crypto.randomUUID(),
		site_id: siteId,
		// The wire schema requires a non-blank name, so this cannot be reached with an empty one.
		name: orNull(input.name) ?? '',
		domain: normalizeCompanyDomain(input.domain),
		status: input.status ?? 'lead',
		notes: orNull(input.notes),
		owner_user_id: orNull(input.owner_user_id),
		created_at: now,
		updated_at: now,
	};
	await crmDb(binding).insert(crmSchema.companies).values(row);
	return row;
}

export function getCompany(
	binding: D1Database,
	siteId: string,
	id: string,
): Promise<Company | undefined> {
	return crmDb(binding)
		.select()
		.from(crmSchema.companies)
		.where(and(eq(crmSchema.companies.site_id, siteId), eq(crmSchema.companies.id, id)))
		.get();
}

export interface ListCompaniesOptions {
	status?: string;
	/** Substring match over name/domain. Bounded by the caller's schema. */
	q?: string;
	limit: number;
	offset: number;
}

export async function listCompanies(
	binding: D1Database,
	siteId: string,
	opts: ListCompaniesOptions,
): Promise<{ companies: Company[]; total: number }> {
	const filters = [eq(crmSchema.companies.site_id, siteId)];
	if (opts.status) {
		filters.push(eq(crmSchema.companies.status, opts.status));
	}
	if (opts.q) {
		const anyField = or(
			likeMatch(crmSchema.companies.name, opts.q),
			likeMatch(crmSchema.companies.domain, opts.q),
		);
		if (anyField) {
			filters.push(anyField);
		}
	}
	const where = and(...filters);
	const client = crmDb(binding);
	const [companies, totalRow] = await Promise.all([
		client
			.select()
			.from(crmSchema.companies)
			.where(where)
			.orderBy(desc(crmSchema.companies.created_at))
			.limit(opts.limit)
			.offset(opts.offset),
		client.select({ n: sql<number>`count(*)` }).from(crmSchema.companies).where(where).get(),
	]);
	return { companies, total: totalRow?.n ?? 0 };
}

/**
 * What a company rollup has to work with: how many contacts it has in total, and the external user
 * ids among them that could possibly resolve to analytics.
 *
 * The two numbers are separate on purpose. `contacts_total` is the denominator a reader needs in
 * order not to mistake "the three people who consented" for "this company", and it counts contacts
 * with no `external_user_id` — who can never link — as well as those who simply have not consented.
 */
export async function companyContactLinkage(
	binding: D1Database,
	siteId: string,
	companyId: string,
	limit: number,
): Promise<{ contacts_total: number; external_user_ids: string[]; truncated: boolean }> {
	const client = crmDb(binding);
	const atCompany = and(
		eq(crmSchema.contacts.site_id, siteId),
		eq(crmSchema.contacts.company_id, companyId),
	);
	const [totalRow, rows] = await Promise.all([
		client.select({ n: sql<number>`count(*)` }).from(crmSchema.contacts).where(atCompany).get(),
		client
			.select({ external_user_id: crmSchema.contacts.external_user_id })
			.from(crmSchema.contacts)
			.where(and(atCompany, isNotNull(crmSchema.contacts.external_user_id)))
			.orderBy(desc(crmSchema.contacts.created_at))
			// One past the cap, so truncation is detected rather than assumed from a full page.
			.limit(limit + 1),
	]);
	const ids = rows.map((r) => r.external_user_id as string);
	return {
		contacts_total: totalRow?.n ?? 0,
		external_user_ids: ids.slice(0, limit),
		truncated: ids.length > limit,
	};
}

/** Partial update, same rule as `updateContact`: only keys present in `input` are written. */
export async function updateCompany(
	binding: D1Database,
	siteId: string,
	id: string,
	input: CompanyInput,
	now: number,
): Promise<Company | undefined> {
	const set: Record<string, string | number | null> = { updated_at: now };
	// The wire schema rejects a present-but-blank name, so this only ever writes a real one.
	if ('name' in input && orNull(input.name)) set.name = orNull(input.name);
	if ('domain' in input) set.domain = normalizeCompanyDomain(input.domain);
	if ('status' in input && input.status) set.status = input.status;
	if ('notes' in input) set.notes = orNull(input.notes);
	if ('owner_user_id' in input) set.owner_user_id = orNull(input.owner_user_id);
	const updated = await crmDb(binding)
		.update(crmSchema.companies)
		.set(set)
		.where(and(eq(crmSchema.companies.site_id, siteId), eq(crmSchema.companies.id, id)))
		.returning();
	return updated[0];
}

/**
 * Delete a company, moving its contacts back to free text first.
 *
 * Deleting an organization must not delete people, and it must not silently erase where they work
 * either: `company_id` is nulled, and the company's name is written into each contact's `company`
 * column, so the answer a read gives for "where does this person work" is the same before and after.
 * That write-back is also what satisfies the foreign key — no row references the company by the time
 * it goes.
 *
 * Both statements go in one D1 batch, which is a transaction. Run separately, a failure between them
 * would leave contacts detached from a company that still exists: not a crash, just a quietly wrong
 * state that nothing would ever surface.
 */
export async function deleteCompany(
	binding: D1Database,
	siteId: string,
	id: string,
): Promise<{ company: Company; contacts_unlinked: number } | undefined> {
	const client = crmDb(binding);
	const company = await getCompany(binding, siteId, id);
	if (!company) return undefined;
	const [unlinked, deleted] = await client.batch([
		client
			.update(crmSchema.contacts)
			.set({ company: company.name, company_id: null })
			.where(
				and(
					eq(crmSchema.contacts.site_id, siteId),
					eq(crmSchema.contacts.company_id, company.id),
				),
			)
			.returning({ id: crmSchema.contacts.id }),
		client
			.delete(crmSchema.companies)
			.where(and(eq(crmSchema.companies.site_id, siteId), eq(crmSchema.companies.id, id)))
			.returning({ id: crmSchema.companies.id }),
	]);
	// Lost a race with a concurrent delete: the batch changed nothing, and 404 is the honest answer.
	if (deleted.length === 0) return undefined;
	return { company, contacts_unlinked: unlinked.length };
}
