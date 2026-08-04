// Typed access to the OPTIONAL CRM database. Mirrors db/queries.ts for `DB`, over a different
// binding and a different schema — route handlers call these helpers rather than writing SQL, and
// nothing outside this file touches `env.CRM_DB`.
//
// Every read and write here is scoped by `site_id`, always taken from the authenticated request and
// never from a body, so a session with a role on one site cannot reach another site's contacts even
// by guessing a contact id.

import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
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

/** A contact as stored. Column names are the wire names; there is no separate mapping layer. */
export type Contact = typeof crmSchema.contacts.$inferSelect;

/** The fields a caller may set. `id`/`site_id`/`created_at`/`updated_at` are server-owned. */
export interface ContactInput {
	external_user_id?: string | null;
	email?: string | null;
	name?: string | null;
	phone?: string | null;
	company?: string | null;
	title?: string | null;
	status?: string;
	source?: string | null;
	notes?: string | null;
	owner_user_id?: string | null;
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

export async function insertContact(
	binding: D1Database,
	siteId: string,
	input: ContactInput,
	now: number,
): Promise<Contact> {
	const row = {
		id: crypto.randomUUID(),
		site_id: siteId,
		external_user_id: orNull(input.external_user_id),
		email: normalizeEmail(input.email),
		name: orNull(input.name),
		phone: orNull(input.phone),
		company: orNull(input.company),
		title: orNull(input.title),
		status: input.status ?? 'lead',
		source: orNull(input.source),
		notes: orNull(input.notes),
		owner_user_id: orNull(input.owner_user_id),
		created_at: now,
		updated_at: now,
	};
	await crmDb(binding).insert(crmSchema.contacts).values(row);
	return row;
}

export function getContact(
	binding: D1Database,
	siteId: string,
	id: string,
): Promise<Contact | undefined> {
	return crmDb(binding)
		.select()
		.from(crmSchema.contacts)
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
		// Escape the LIKE metacharacters so a `%` in the search box means a literal percent sign
		// rather than "match everything" — without this, `q=%` scans the whole table.
		const term = `%${opts.q.replace(/[\\%_]/g, '\\$&')}%`;
		const anyField = or(
			like(crmSchema.contacts.name, term),
			like(crmSchema.contacts.email, term),
			like(crmSchema.contacts.company, term),
		);
		if (anyField) {
			filters.push(anyField);
		}
	}
	const where = and(...filters);
	const client = crmDb(binding);
	const [contacts, totalRow] = await Promise.all([
		client
			.select()
			.from(crmSchema.contacts)
			.where(where)
			.orderBy(desc(crmSchema.contacts.created_at))
			.limit(opts.limit)
			.offset(opts.offset),
		client.select({ n: sql<number>`count(*)` }).from(crmSchema.contacts).where(where).get(),
	]);
	return { contacts, total: totalRow?.n ?? 0 };
}

/** Apply a partial update. Only keys actually present in `input` are written, so a PATCH that omits
 * a field leaves it alone rather than nulling it. Returns the updated row, or undefined if the
 * contact does not exist on this site. */
export async function updateContact(
	binding: D1Database,
	siteId: string,
	id: string,
	input: ContactInput,
	now: number,
): Promise<Contact | undefined> {
	const set: Record<string, string | number | null> = { updated_at: now };
	if ('external_user_id' in input) set.external_user_id = orNull(input.external_user_id);
	if ('email' in input) set.email = normalizeEmail(input.email);
	if ('name' in input) set.name = orNull(input.name);
	if ('phone' in input) set.phone = orNull(input.phone);
	if ('company' in input) set.company = orNull(input.company);
	if ('title' in input) set.title = orNull(input.title);
	if ('status' in input && input.status) set.status = input.status;
	if ('source' in input) set.source = orNull(input.source);
	if ('notes' in input) set.notes = orNull(input.notes);
	if ('owner_user_id' in input) set.owner_user_id = orNull(input.owner_user_id);
	const updated = await crmDb(binding)
		.update(crmSchema.contacts)
		.set(set)
		.where(and(eq(crmSchema.contacts.site_id, siteId), eq(crmSchema.contacts.id, id)))
		.returning();
	return updated[0];
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
