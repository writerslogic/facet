// React Query hooks for the optional CRM extension. Every call goes through `sessionFetch`, which
// carries the operator session cookie and NO API key — the `/api/crm/*` routes refuse keys by design.
//
// Retries: a 501 (no CRM database), a 403 (role too low), a 401 (no session) and a 503 (accounts off)
// are all facts about the deployment or the operator, not transient failures. Re-asking cannot change
// any of them, so they fail on the first response and the tab renders its explanation immediately
// instead of spinning through react-query's default three attempts first.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionFetch } from '../api.js';
import {
	type CompanyAnalytics,
	type ContactAnalytics,
	type CrmAuditEntry,
	type CrmCompany,
	type CrmContact,
	type CrmDeal,
	type PipelineCurrencySummary,
	crmBlockOf,
} from '../lib/crm.js';

const retry = (failureCount: number, error: unknown): boolean =>
	crmBlockOf(error) === null && failureCount < 1;

/** Page size for both list views. The API caps `limit` at 100 and defaults to 25. */
export const CRM_PAGE_SIZE = 25;

export interface CrmListParams {
	/** `''` means every status. */
	status: string;
	/** Bounded substring search; `''` means no search. */
	q: string;
	offset: number;
}

/** The `site_id`/`limit`/`offset` scaffold every paged CRM query starts from, before its own filters
 * are layered on — `limit` is always the shared page size, since none of these views ever page at a
 * different rate. */
function baseListQuery(siteId: string, offset: number): URLSearchParams {
	return new URLSearchParams({
		site_id: siteId,
		limit: String(CRM_PAGE_SIZE),
		offset: String(offset),
	});
}

function listPath(base: string, siteId: string, params: CrmListParams): string {
	const qs = baseListQuery(siteId, params.offset);
	if (params.status) qs.set('status', params.status);
	const q = params.q.trim();
	if (q) qs.set('q', q);
	return `${base}?${qs.toString()}`;
}

export function useContacts(siteId: string, params: CrmListParams) {
	return useQuery({
		queryKey: ['crm', 'contacts', siteId, params],
		queryFn: () =>
			sessionFetch<{ contacts: CrmContact[]; total: number; role?: string }>(
				listPath('/api/crm/contacts', siteId, params),
			),
		enabled: Boolean(siteId),
		retry,
	});
}

export function useContact(siteId: string, id: string) {
	return useQuery({
		queryKey: ['crm', 'contact', siteId, id],
		queryFn: () =>
			sessionFetch<{ contact: CrmContact }>(`/api/crm/contacts/${id}?site_id=${siteId}`),
		enabled: Boolean(siteId && id),
		retry,
	});
}

export function useContactAnalytics(siteId: string, id: string) {
	return useQuery({
		queryKey: ['crm', 'contact-analytics', siteId, id],
		queryFn: () =>
			sessionFetch<ContactAnalytics>(`/api/crm/contacts/${id}/analytics?site_id=${siteId}`),
		enabled: Boolean(siteId && id),
		retry,
	});
}

export function useCompanies(siteId: string, params: CrmListParams) {
	return useQuery({
		queryKey: ['crm', 'companies', siteId, params],
		queryFn: () =>
			sessionFetch<{ companies: CrmCompany[]; total: number; role?: string }>(
				listPath('/api/crm/companies', siteId, params),
			),
		enabled: Boolean(siteId),
		retry,
	});
}

/** The API's own ceiling on a CRM page. */
export const CRM_MAX_PAGE_SIZE = 100;

/**
 * The companies a contact form can link to. Deliberately a separate query from the paged roster: the
 * picker needs one flat set, not whatever page the list happens to be showing. It runs only while a
 * form is mounted, and the caller compares `companies.length` against `total` so a site with more
 * companies than one page holds says so rather than silently omitting them.
 */
export function useCompanyOptions(siteId: string) {
	return useQuery({
		queryKey: ['crm', 'company-options', siteId],
		queryFn: () =>
			sessionFetch<{ companies: CrmCompany[]; total: number; role?: string }>(
				`/api/crm/companies?site_id=${siteId}&limit=${CRM_MAX_PAGE_SIZE}&offset=0`,
			),
		enabled: Boolean(siteId),
		staleTime: 5 * 60 * 1000,
		retry,
	});
}

/**
 * The contacts a deal form can link to. A separate flat query for the same reason
 * `useCompanyOptions` is: the picker needs every contact up to the API's ceiling, not whatever page
 * the roster happens to be showing.
 */
export function useContactOptions(siteId: string) {
	return useQuery({
		queryKey: ['crm', 'contact-options', siteId],
		queryFn: () =>
			sessionFetch<{ contacts: CrmContact[]; total: number; role?: string }>(
				`/api/crm/contacts?site_id=${siteId}&limit=${CRM_MAX_PAGE_SIZE}&offset=0`,
			),
		enabled: Boolean(siteId),
		staleTime: 5 * 60 * 1000,
		retry,
	});
}

export function useCompany(siteId: string, id: string) {
	return useQuery({
		queryKey: ['crm', 'company', siteId, id],
		queryFn: () =>
			sessionFetch<{ company: CrmCompany }>(`/api/crm/companies/${id}?site_id=${siteId}`),
		enabled: Boolean(siteId && id),
		retry,
	});
}

export function useCompanyContacts(siteId: string, id: string, offset: number) {
	return useQuery({
		queryKey: ['crm', 'company-contacts', siteId, id, offset],
		queryFn: () =>
			sessionFetch<{ contacts: CrmContact[]; total: number; role?: string }>(
				`/api/crm/companies/${id}/contacts?site_id=${siteId}&limit=${CRM_PAGE_SIZE}&offset=${offset}`,
			),
		enabled: Boolean(siteId && id),
		retry,
	});
}

export function useCompanyAnalytics(siteId: string, id: string) {
	return useQuery({
		queryKey: ['crm', 'company-analytics', siteId, id],
		queryFn: () =>
			sessionFetch<CompanyAnalytics>(`/api/crm/companies/${id}/analytics?site_id=${siteId}`),
		enabled: Boolean(siteId && id),
		retry,
	});
}

/** The deal list filters. `stage`/`companyId`/`contactId` are each exact matches; `q` is the bounded
 * substring search over the deal name. */
export interface DealListParams {
	/** `''` means every stage. */
	stage: string;
	/** `''` means unfiltered. */
	companyId: string;
	/** `''` means unfiltered. */
	contactId: string;
	q: string;
	offset: number;
}

export function useDeals(siteId: string, params: DealListParams) {
	return useQuery({
		queryKey: ['crm', 'deals', siteId, params],
		queryFn: () => {
			const qs = baseListQuery(siteId, params.offset);
			if (params.stage) qs.set('stage', params.stage);
			if (params.companyId) qs.set('company_id', params.companyId);
			if (params.contactId) qs.set('contact_id', params.contactId);
			const q = params.q.trim();
			if (q) qs.set('q', q);
			return sessionFetch<{ deals: CrmDeal[]; total: number; role?: string }>(
				`/api/crm/deals?${qs.toString()}`,
			);
		},
		enabled: Boolean(siteId),
		retry,
	});
}

export function useDeal(siteId: string, id: string) {
	return useQuery({
		queryKey: ['crm', 'deal', siteId, id],
		queryFn: () => sessionFetch<{ deal: CrmDeal }>(`/api/crm/deals/${id}?site_id=${siteId}`),
		enabled: Boolean(siteId && id),
		retry,
	});
}

/**
 * The pipeline summary. Not filtered by anything the list is — it is a total across every deal on the
 * site, regardless of what the roster's search or stage filter currently shows.
 */
export function useDealPipeline(siteId: string) {
	return useQuery({
		queryKey: ['crm', 'pipeline', siteId],
		queryFn: () =>
			sessionFetch<{ pipeline: PipelineCurrencySummary[] }>(
				`/api/crm/pipeline?site_id=${siteId}`,
			),
		enabled: Boolean(siteId),
		retry,
	});
}

/**
 * One page of the access log, with the two facts a reader needs beside the rows.
 *
 * `covers_since`/`retention_days` are the horizon: this is the one CRM table that ages out, so an
 * empty page means either that nothing happened or that it happened too long ago, and the rows alone
 * cannot tell those apart. The server reports the window so the panel can.
 */
export interface CrmAuditPage {
	entries: CrmAuditEntry[];
	total: number;
	role?: string;
	retention_days: number;
	covers_since: number;
}

/** The audit filters, all exact matches — the log holds ids and action names, not prose to search. */
export interface CrmAuditParams {
	/** `''` means every action. */
	action: string;
	/** A contact or company id; `''` means every target. */
	targetId: string;
	/** An operator id; `''` means every operator. */
	actorUserId: string;
	offset: number;
}

/**
 * The access log for this site.
 *
 * Deliberately NOT cached across filter changes the way the list queries are: the point of this view
 * is to answer "what has happened", and a stale answer to that is worse than a slow one. `staleTime`
 * is left at the client default (60s) rather than raised, and every CRM mutation elsewhere in the tab
 * invalidates it, because every one of them writes an entry.
 */
export function useCrmAudit(siteId: string, params: CrmAuditParams) {
	return useQuery({
		queryKey: ['crm', 'audit', siteId, params],
		queryFn: () => {
			const qs = baseListQuery(siteId, params.offset);
			if (params.action) qs.set('action', params.action);
			if (params.targetId) qs.set('target_id', params.targetId);
			if (params.actorUserId) qs.set('actor_user_id', params.actorUserId);
			return sessionFetch<CrmAuditPage>(`/api/crm/audit?${qs.toString()}`);
		},
		enabled: Boolean(siteId),
		retry,
	});
}

/**
 * Mark the access log stale. Called by every mutation here, because every one of them writes an
 * entry — the log is a record of requests, not of records, so a change that leaves it untouched in
 * the cache would show an admin a page that is missing the very act they just performed.
 */
function auditIsStale(qc: ReturnType<typeof useQueryClient>, siteId: string): Promise<void> {
	return qc.invalidateQueries({ queryKey: ['crm', 'audit', siteId] });
}

/** Field values a create/update submits. Empty strings are meaningful: the API normalises them to
 * NULL, which is how a form clears a field it previously set. */
export type CrmFields = Record<string, string>;

/** A deal create/update body. `value`/`expected_close_date` must be real numbers and `currency` a
 * validated 3-letter code — the schema rejects a stringified number and an empty-string currency, so
 * these three are omit-when-unset rather than the other CRM entities' empty-string-clears-it. */
export interface DealFields {
	name?: string;
	stage?: string;
	value?: number;
	currency?: string;
	expected_close_date?: number;
	company_id?: string;
	contact_id?: string;
	notes?: string;
}

export function useCreateContact(siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: CrmFields) =>
			sessionFetch<{ contact: CrmContact }>(`/api/crm/contacts?site_id=${siteId}`, {
				method: 'POST',
				body,
			}),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['crm', 'contacts', siteId] });
			void auditIsStale(qc, siteId);
		},
	});
}

export function useUpdateContact(siteId: string, id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: CrmFields) =>
			sessionFetch<{ contact: CrmContact }>(`/api/crm/contacts/${id}?site_id=${siteId}`, {
				method: 'PATCH',
				body,
			}),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['crm', 'contacts', siteId] });
			void qc.invalidateQueries({ queryKey: ['crm', 'contact', siteId, id] });
			// The employer may have changed, which moves this person in and out of a company roster.
			void qc.invalidateQueries({ queryKey: ['crm', 'company-contacts', siteId] });
			void qc.invalidateQueries({ queryKey: ['crm', 'company-analytics', siteId] });
			// A changed external_user_id changes what the analytics link resolves to.
			void qc.invalidateQueries({ queryKey: ['crm', 'contact-analytics', siteId, id] });
			void auditIsStale(qc, siteId);
		},
	});
}

export function useDeleteContact(siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			sessionFetch<{
				deleted: boolean;
				consent_records_erased: number;
				deals_unlinked: number;
			}>(`/api/crm/contacts/${id}?site_id=${siteId}`, { method: 'DELETE' }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['crm', 'contacts', siteId] });
			void qc.invalidateQueries({ queryKey: ['crm', 'company-contacts', siteId] });
			void qc.invalidateQueries({ queryKey: ['crm', 'company-analytics', siteId] });
			// Every deal naming this contact had contact_id nulled server-side.
			void qc.invalidateQueries({ queryKey: ['crm', 'deals', siteId] });
			void qc.invalidateQueries({ queryKey: ['crm', 'deal', siteId] });
			void auditIsStale(qc, siteId);
		},
	});
}

export function useCreateCompany(siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: CrmFields) =>
			sessionFetch<{ company: CrmCompany }>(`/api/crm/companies?site_id=${siteId}`, {
				method: 'POST',
				body,
			}),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['crm', 'companies', siteId] });
			// The contact form's company picker reads its own query; without this a company created
			// here is missing from the picker until the cache expires.
			void qc.invalidateQueries({ queryKey: ['crm', 'company-options', siteId] });
			void auditIsStale(qc, siteId);
		},
	});
}

export function useUpdateCompany(siteId: string, id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: CrmFields) =>
			sessionFetch<{ company: CrmCompany }>(`/api/crm/companies/${id}?site_id=${siteId}`, {
				method: 'PATCH',
				body,
			}),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['crm', 'companies', siteId] });
			void qc.invalidateQueries({ queryKey: ['crm', 'company', siteId, id] });
			void qc.invalidateQueries({ queryKey: ['crm', 'company-options', siteId] });
			// A renamed company is the resolved `company` label on every one of its contacts.
			void qc.invalidateQueries({ queryKey: ['crm', 'contacts', siteId] });
			void auditIsStale(qc, siteId);
		},
	});
}

/** Delete a company. Its contacts and deals survive — the API unlinks them and reports how many of
 * each. */
export function useDeleteCompany(siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			sessionFetch<{ deleted: boolean; contacts_unlinked: number; deals_unlinked: number }>(
				`/api/crm/companies/${id}?site_id=${siteId}`,
				{ method: 'DELETE' },
			),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['crm', 'companies', siteId] });
			void qc.invalidateQueries({ queryKey: ['crm', 'company-options', siteId] });
			// Every unlinked contact's `company` and `company_id` changed.
			void qc.invalidateQueries({ queryKey: ['crm', 'contacts', siteId] });
			// Every unlinked deal's `company_id` changed too.
			void qc.invalidateQueries({ queryKey: ['crm', 'deals', siteId] });
			void qc.invalidateQueries({ queryKey: ['crm', 'deal', siteId] });
			void auditIsStale(qc, siteId);
		},
	});
}

/** The pipeline is a derived total over every deal's `stage`/`value`/`currency`, so any deal write
 * invalidates it alongside the list — a create, an edit that changes stage or value, and a delete all
 * move the numbers it reports. */
function pipelineIsStale(qc: ReturnType<typeof useQueryClient>, siteId: string): Promise<void> {
	return qc.invalidateQueries({ queryKey: ['crm', 'pipeline', siteId] });
}

export function useCreateDeal(siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: DealFields) =>
			sessionFetch<{ deal: CrmDeal }>(`/api/crm/deals?site_id=${siteId}`, {
				method: 'POST',
				body,
			}),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['crm', 'deals', siteId] });
			void pipelineIsStale(qc, siteId);
			void auditIsStale(qc, siteId);
		},
	});
}

export function useUpdateDeal(siteId: string, id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: DealFields) =>
			sessionFetch<{ deal: CrmDeal }>(`/api/crm/deals/${id}?site_id=${siteId}`, {
				method: 'PATCH',
				body,
			}),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['crm', 'deals', siteId] });
			void qc.invalidateQueries({ queryKey: ['crm', 'deal', siteId, id] });
			void pipelineIsStale(qc, siteId);
			void auditIsStale(qc, siteId);
		},
	});
}

export function useDeleteDeal(siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			sessionFetch<{ deleted: boolean }>(`/api/crm/deals/${id}?site_id=${siteId}`, {
				method: 'DELETE',
			}),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ['crm', 'deals', siteId] });
			void pipelineIsStale(qc, siteId);
			void auditIsStale(qc, siteId);
		},
	});
}
