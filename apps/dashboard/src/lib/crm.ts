// Wire types and access rules for the optional CRM extension. The row shapes mirror the CRM
// database columns exactly (snake_case, unix-ms timestamps) rather than remapping them, matching how
// every other read in this app parses the API's own field names.
//
// Two classifications live here because the CRM tab's whole behaviour turns on them:
//
//   • WHY A REQUEST FAILED. A 501 is not an error the reader did anything about — it is the DEFAULT
//     state of a deployment that never bound `CRM_DB`, and it must read as "this feature is not
//     installed", never as a failure. A 403 is a role fact, a 401 is a missing session, and a 503 is
//     a deployment with accounts switched off entirely. Each has a different sentence and none of
//     them is retryable, so they are separated from the transient failures that are.
//
//   • WHETHER THE OPERATOR MAY DESTROY OR EXPORT. See `canAdministerCrm`.

import type { CompanyStatus, ContactStatus, DealStage } from '@facet/shared';
import { formatNumber } from './format.js';

/** A person in the CRM, exactly as `GET /api/crm/contacts` returns them. */
export interface CrmContact {
	id: string;
	site_id: string;
	external_user_id: string | null;
	email: string | null;
	name: string | null;
	phone: string | null;
	/** The RESOLVED employer: the linked company's name, or the free text typed for an unlinked one. */
	company: string | null;
	/** Set when `company` came from a linked `companies` row. Null when `company` is free text. */
	company_id: string | null;
	title: string | null;
	/** Stored as free text in SQLite, so an unexpected value must render rather than crash. */
	status: string;
	source: string | null;
	notes: string | null;
	owner_user_id: string | null;
	created_at: number;
	updated_at: number;
}

/** An organization, as `GET /api/crm/companies` returns them. */
export interface CrmCompany {
	id: string;
	site_id: string;
	name: string;
	domain: string | null;
	status: string;
	notes: string | null;
	owner_user_id: string | null;
	created_at: number;
	updated_at: number;
}

/** A sales opportunity, as `GET /api/crm/deals` returns it. Unlike a contact, `company`/`contact` are
 * NOT resolved to a name here — the API returns only the ids, so the detail view looks the name up
 * through the same `useCompany`/`useContact` hooks a cross-tab link would use anyway. */
export interface CrmDeal {
	id: string;
	site_id: string;
	name: string;
	company_id: string | null;
	contact_id: string | null;
	stage: string;
	/** Cents, or null when nobody has priced this deal yet — distinct from a deal genuinely worth zero. */
	value: number | null;
	/** ISO 4217, uppercase. Set exactly when `value` is set. */
	currency: string | null;
	/** Unix ms, or null when there is no target date. */
	expected_close_date: number | null;
	notes: string | null;
	owner_user_id: string | null;
	created_at: number;
	updated_at: number;
}

/** One currency's slice of the pipeline, as `GET /api/crm/pipeline` returns it. Per-currency because
 * summing `open_value` across rows would add unlike units. */
export interface PipelineCurrencySummary {
	currency: string;
	open_value: number;
	open_count: number;
	won_value: number;
	won_count: number;
}

/** The activity summary shared by the contact and company analytics responses. */
export interface CrmActivity {
	pageviews: number;
	/** Custom (named) events only — NOT the total, which counts pageviews too. */
	events: number;
	total: number;
	first_seen: number | null;
	last_seen: number | null;
	top_paths: { path: string; views: number }[];
}

/**
 * One contact's analytics. `linked: false` is a first-class answer, not an empty success: it means
 * nothing authorizes connecting this person to any events, which is a different claim from "this
 * person did nothing" and must never be rendered as zeroes.
 */
export type ContactAnalytics =
	| { linked: false; reason: string }
	| { linked: true; windows: number; activity: CrmActivity };

/** The contact counts every company rollup carries, linked or not — the denominator. */
export interface CompanyRollupCounts {
	contacts_total: number;
	contacts_linked: number;
	contacts_considered: number;
	contacts_truncated: boolean;
	contacts_limit: number;
}

export type CompanyAnalytics = CompanyRollupCounts &
	(
		| { linked: false; reason: string }
		| { linked: true; visitor_hashes: number; activity: CrmActivity }
	);

/**
 * One access-log entry, as `GET /api/crm/audit` returns it.
 *
 * `target_id` is a contact or company id and nothing resolves it to a name — deliberately, because
 * the log holds no contact fields, and once a record is erased its id points at nothing. So the UI
 * shows the id and offers to filter by it rather than pretending to know who it was.
 */
export interface CrmAuditEntry {
	id: string;
	site_id: string;
	actor_user_id: string;
	/** Null once the account is closed. The id remains, so the entry still names someone specific. */
	actor_email: string | null;
	/** The role the request was AUTHORIZED under, not the role that operator holds today. */
	actor_role: string;
	action: string;
	target_id: string | null;
	occurred_at: number;
}

/** The reason a CRM request cannot succeed, in a form the UI can turn into one specific sentence. */
export type CrmBlock = 'unavailable' | 'accounts-off' | 'signed-out' | 'forbidden';

/** Classify a CRM/session failure. Returns null for anything transient (which IS worth retrying). */
export function crmBlockOf(error: unknown): CrmBlock | null {
	if (!(error instanceof Error)) return null;
	switch (error.message) {
		case 'crm_unavailable':
			return 'unavailable';
		case 'auth_unavailable':
			return 'accounts-off';
		case 'unauthorized':
		case 'unauthenticated':
			return 'signed-out';
		case 'forbidden':
			return 'forbidden';
		default:
			return null;
	}
}

/** A team role, ordered. Mirrors `Role`/`ROLE_RANK` in the Worker's accounts library. */
export type TeamRole = 'owner' | 'admin' | 'analyst' | 'viewer';

const ROLE_RANK: Record<TeamRole, number> = {
	viewer: 0,
	analyst: 1,
	admin: 2,
	owner: 3,
};

function isTeamRole(value: string): value is TeamRole {
	return value in ROLE_RANK;
}

/**
 * May this operator delete or export CRM records — the `admin` gate on the two irreversible and
 * bulk-disclosure routes?
 *
 * Answered from the role the SERVER reports on each list response, which is the exact role it
 * resolved to authorize that request. The browser cannot derive this for itself: `/api/auth/me`
 * reports a role per team, and no session-reachable route says which team owns the selected site, so
 * anything computed here would be a guess. Undefined means not yet known, which reads as "no" — the
 * button appears once the answer arrives rather than flickering out when it does.
 */
export function canAdministerCrm(role: string | undefined): boolean {
	return role !== undefined && isTeamRole(role) && ROLE_RANK[role] >= ROLE_RANK.admin;
}

/** The closed status sets, for the form controls. Declared once so both forms stay in step. */
export const CONTACT_STATUSES: ContactStatus[] = ['lead', 'active', 'archived'];
export const COMPANY_STATUSES: CompanyStatus[] = ['lead', 'active', 'archived'];
/** `won`/`lost` are terminal; the pipeline summary treats every other stage as open. */
export const DEAL_STAGES: DealStage[] = [
	'lead',
	'qualified',
	'proposal',
	'negotiation',
	'won',
	'lost',
];

/** Format a deal amount in its currency, given as cents. Falls back to a plain number when there is
 * no currency to format against — a deal with `value` unset never reaches this, since the API pairs
 * the two, but `currency` alone is not something `Intl` can be trusted with unvalidated. */
export function formatMoney(cents: number, currency: string | null): string {
	if (currency) {
		try {
			return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
				cents / 100,
			);
		} catch {
			// Unknown/invalid currency code — fall through to a plain number.
		}
	}
	return formatNumber(cents / 100);
}

/**
 * What kind of act an audit action was, which is what a reader scanning a page of them is actually
 * looking for. An erasure and a list read are both "an access" and are not remotely the same event.
 *
 * `export` is separated from the other reads because it is the single request that discloses the most
 * about one person, and `erase` from the other writes because it is the only irreversible one.
 */
export type AuditTone = 'erase' | 'export' | 'write' | 'read';

export function auditTone(action: string): AuditTone {
	if (action.endsWith('.delete')) return 'erase';
	if (action === 'contact.export') return 'export';
	if (action.endsWith('.create') || action.endsWith('.update')) return 'write';
	return 'read';
}

/**
 * Prose for an audit action. Unknown codes fall back to the code, for the same reason
 * `linkReasonText` does: a server that starts recording something this build has no name for should
 * show the name it does have, not drop the row.
 */
export function auditActionText(action: string): string {
	switch (action) {
		case 'contact.list':
			return 'Listed contacts';
		case 'contact.create':
			return 'Created a contact';
		case 'contact.read':
			return 'Opened a contact';
		case 'contact.update':
			return 'Edited a contact';
		case 'contact.delete':
			return 'Erased a contact';
		case 'contact.analytics':
			return 'Viewed a contact’s analytics';
		case 'contact.export':
			return 'Exported a contact’s data';
		case 'company.list':
			return 'Listed companies';
		case 'company.create':
			return 'Created a company';
		case 'company.read':
			return 'Opened a company';
		case 'company.update':
			return 'Edited a company';
		case 'company.delete':
			return 'Deleted a company';
		case 'company.contacts':
			return 'Listed a company’s contacts';
		case 'company.analytics':
			return 'Viewed a company rollup';
		case 'deal.list':
			return 'Listed deals';
		case 'deal.create':
			return 'Created a deal';
		case 'deal.read':
			return 'Opened a deal';
		case 'deal.update':
			return 'Edited a deal';
		case 'deal.delete':
			return 'Deleted a deal';
		case 'deal.pipeline':
			return 'Viewed the pipeline summary';
		case 'audit.read':
			return 'Read the access log';
		default:
			return action;
	}
}

/** Prose for a `linked: false` reason code. Unknown codes fall back to the code itself rather than
 * to silence — a reason the reader cannot see is worse than an unfamiliar one. */
export function linkReasonText(reason: string): string {
	switch (reason) {
		case 'no_external_user_id':
			return 'This contact has no external user id, so there is nothing to match against a consent record. Add the id your site passes to Facet for this person.';
		case 'no_active_consent':
			return 'No active signed consent record authorizes linking this person to analytics. Either they never gave identified consent, or the record has since been revoked or purged by retention.';
		case 'no_linked_contacts':
			return 'No contact at this company has an active signed consent record authorizing a link to analytics.';
		case 'none_linked_within_cap':
			return 'None of the contacts examined has an active signed consent record. This company has more contacts than one rollup resolves, so older ones were not checked and may well be linked.';
		default:
			return `The API gave the reason code "${reason}".`;
	}
}
