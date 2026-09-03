// Tenant-scoped data helpers for the privacy-first CRM foundation. The API layer is intentionally
// absent in this milestone; these are the small query contracts the future handlers will call.

import { type SQL, and, desc, eq, lt, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../env.js';
import { ApiError } from '../lib/http.js';
import * as crmSchema from './crm-schema.js';

export const CRM_MAX_PAGE = 100;

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

function crmDb(binding: D1Database) {
	return drizzle(binding, { schema: crmSchema });
}

type StoredContact = typeof crmSchema.crmContacts.$inferSelect;

/** The digest is a lookup key and cannot become a response field by serializing this type. */
export type Contact = Omit<StoredContact, 'external_id_hash'>;

const CONTACT_COLUMNS = {
	id: crmSchema.crmContacts.id,
	site_id: crmSchema.crmContacts.site_id,
	alias: crmSchema.crmContacts.alias,
	lifecycle_state: crmSchema.crmContacts.lifecycle_state,
	legal_basis: crmSchema.crmContacts.legal_basis,
	origin_source: crmSchema.crmContacts.origin_source,
	origin_occurred_at: crmSchema.crmContacts.origin_occurred_at,
	consent_captured_at: crmSchema.crmContacts.consent_captured_at,
	score: crmSchema.crmContacts.score,
	created_at: crmSchema.crmContacts.created_at,
	updated_at: crmSchema.crmContacts.updated_at,
};

export interface ContactPageCursor {
	created_at: number;
	id: string;
}

export interface ListContactsPageOptions {
	limit: number;
	cursor?: ContactPageCursor;
}

/** Stable keyset pagination over `(created_at, id)`, scoped by tenant and without a COUNT scan. */
export async function listContactsPage(
	binding: D1Database,
	siteId: string,
	opts: ListContactsPageOptions,
): Promise<{ contacts: Contact[]; next_cursor: ContactPageCursor | null }> {
	if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > CRM_MAX_PAGE) {
		throw new ApiError('invalid_page_limit', 400);
	}
	if (
		opts.cursor &&
		(!Number.isSafeInteger(opts.cursor.created_at) ||
			opts.cursor.created_at < 0 ||
			!opts.cursor.id)
	) {
		throw new ApiError('invalid_page_cursor', 400);
	}

	const filters = [eq(crmSchema.crmContacts.site_id, siteId)];
	if (opts.cursor) {
		filters.push(
			or(
				lt(crmSchema.crmContacts.created_at, opts.cursor.created_at),
				and(
					eq(crmSchema.crmContacts.created_at, opts.cursor.created_at),
					lt(crmSchema.crmContacts.id, opts.cursor.id),
				),
			) as SQL,
		);
	}

	const rows = await crmDb(binding)
		.select(CONTACT_COLUMNS)
		.from(crmSchema.crmContacts)
		.where(and(...filters))
		.orderBy(desc(crmSchema.crmContacts.created_at), desc(crmSchema.crmContacts.id))
		.limit(opts.limit + 1);
	const contacts = rows.slice(0, opts.limit);
	const last = contacts.at(-1);
	return {
		contacts,
		next_cursor:
			rows.length > opts.limit && last ? { created_at: last.created_at, id: last.id } : null,
	};
}

const SCORE_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;

export interface ApplyScoreDeltaInput {
	delta: number;
	reason: string;
	rule_id?: string | null;
	occurred_at: number;
	ledger_id?: string;
}

export interface ScoreLedgerEntry {
	id: string;
	site_id: string;
	contact_id: string;
	previous_score: number;
	delta: number;
	next_score: number;
	reason: string;
	rule_id: string | null;
	occurred_at: number;
}

/** The score update and explainability row are one atomic D1 batch. */
export async function applyScoreDelta(
	binding: D1Database,
	siteId: string,
	contactId: string,
	input: ApplyScoreDeltaInput,
): Promise<ScoreLedgerEntry | undefined> {
	if (!Number.isSafeInteger(input.delta) || input.delta === 0) {
		throw new ApiError('invalid_score_delta', 400);
	}
	if (!SCORE_CODE.test(input.reason)) {
		throw new ApiError('invalid_score_reason', 400);
	}
	if (!Number.isSafeInteger(input.occurred_at) || input.occurred_at < 0) {
		throw new ApiError('invalid_score_timestamp', 400);
	}
	const ruleId = input.rule_id?.trim() || null;
	if (ruleId && !SCORE_CODE.test(ruleId)) {
		throw new ApiError('invalid_score_rule', 400);
	}
	const ledgerId = input.ledger_id ?? crypto.randomUUID();
	if (!ledgerId || ledgerId.length > 64) {
		throw new ApiError('invalid_score_ledger_id', 400);
	}

	const [, ledger] = await binding.batch<ScoreLedgerEntry>([
		binding
			.prepare(
				`UPDATE crm_contacts
				 SET score = score + ?, updated_at = max(updated_at, ?)
				 WHERE site_id = ? AND id = ?
				 RETURNING score`,
			)
			.bind(input.delta, input.occurred_at, siteId, contactId),
		binding
			.prepare(
				`INSERT INTO crm_score_ledger
				 (id, site_id, contact_id, previous_score, delta, next_score, reason, rule_id, occurred_at)
				 SELECT ?, site_id, id, score - ?, ?, score, ?, ?, ?
				 FROM crm_contacts
				 WHERE site_id = ? AND id = ?
				 RETURNING id, site_id, contact_id, previous_score, delta, next_score, reason, rule_id,
				           occurred_at`,
			)
			.bind(
				ledgerId,
				input.delta,
				input.delta,
				input.reason,
				ruleId,
				input.occurred_at,
				siteId,
				contactId,
			),
	]);
	return ledger?.results[0];
}
