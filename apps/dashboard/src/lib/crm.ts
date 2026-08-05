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

import type { CompanyStatus, ContactStatus } from '@facet/shared';

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
