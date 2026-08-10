// React Query hooks for the admin API (Bearer ADMIN_TOKEN). All calls go through adminFetch/adminPost
// which refuse any non-admin path. Mutations invalidate the matching list query so panels refresh
// without a full page reload. The admin token is never placed in a query key or URL. Queries use
// `adminQueryRetry`, which refuses to re-send a token the deployment has already rejected.

import type {
	ApiKeyRecord,
	Experiment,
	ExperimentInput,
	Funnel,
	FunnelInput,
	Goal,
	GoalInput,
	IdentityTier,
	SaltWindow,
	SetIdentityInput,
	Site,
} from '@facet/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminFetch, adminPatch, adminPost, adminQueryRetry } from '../admin.js';
import { siteQueryKey } from '../lib/queryKeys.js';

export function useSites(token: string) {
	return useQuery({
		queryKey: ['admin', 'sites'],
		queryFn: () => adminFetch<{ sites: Site[] }>('/api/sites', token),
		retry: adminQueryRetry,
		enabled: Boolean(token),
	});
}

export function useCreateSite(token: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { name: string; domain: string }) =>
			adminPost<{ site: Site }>('/api/sites', token, body),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'sites'] }),
	});
}

export function useKeys(token: string, siteId: string) {
	return useQuery({
		queryKey: siteQueryKey(['admin', 'keys'], siteId),
		queryFn: () => adminFetch<{ keys: ApiKeyRecord[] }>(`/api/keys?site_id=${siteId}`, token),
		retry: adminQueryRetry,
		enabled: Boolean(token && siteId),
	});
}

export function useIssueKey(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { site_id: string; label?: string }) =>
			adminPost<{ id: string; key: string }>('/api/keys', token, body),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'keys', siteId] }),
	});
}

export function useRevokeKey(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			adminFetch<{ deleted: boolean }>(`/api/keys/${id}?site_id=${siteId}`, token, {
				method: 'DELETE',
			}),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'keys', siteId] }),
	});
}

export function useAdminGoals(token: string, siteId: string) {
	return useQuery({
		queryKey: siteQueryKey(['admin', 'goals'], siteId),
		queryFn: () => adminFetch<{ goals: Goal[] }>(`/api/goals?site_id=${siteId}`, token),
		retry: adminQueryRetry,
		enabled: Boolean(token && siteId),
	});
}

export function useCreateGoal(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: GoalInput) => adminPost<{ goal: Goal }>('/api/goals', token, body),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'goals', siteId] }),
	});
}

export function useDeleteGoal(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			adminFetch<{ deleted: boolean }>(`/api/goals/${id}?site_id=${siteId}`, token, {
				method: 'DELETE',
			}),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'goals', siteId] }),
	});
}

export function useAdminFunnels(token: string, siteId: string) {
	return useQuery({
		queryKey: siteQueryKey(['admin', 'funnels'], siteId),
		queryFn: () => adminFetch<{ funnels: Funnel[] }>(`/api/funnels?site_id=${siteId}`, token),
		retry: adminQueryRetry,
		enabled: Boolean(token && siteId),
	});
}

export function useCreateFunnel(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: FunnelInput) =>
			adminPost<{ funnel: Funnel }>('/api/funnels', token, body),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'funnels', siteId] }),
	});
}

export function useDeleteFunnel(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			adminFetch<{ deleted: boolean }>(`/api/funnels/${id}?site_id=${siteId}`, token, {
				method: 'DELETE',
			}),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'funnels', siteId] }),
	});
}

export function useAdminExperiments(token: string, siteId: string) {
	return useQuery({
		queryKey: siteQueryKey(['admin', 'experiments'], siteId),
		queryFn: () =>
			adminFetch<{ experiments: Experiment[] }>(`/api/experiments?site_id=${siteId}`, token),
		retry: adminQueryRetry,
		enabled: Boolean(token && siteId),
	});
}

export function useCreateExperiment(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: ExperimentInput) =>
			adminPost<{ experiment: Experiment }>('/api/experiments', token, body),
		onSuccess: () =>
			qc.invalidateQueries({
				queryKey: ['admin', 'experiments', siteId],
			}),
	});
}

export function useDeleteExperiment(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			adminFetch<{ deleted: boolean }>(`/api/experiments/${id}?site_id=${siteId}`, token, {
				method: 'DELETE',
			}),
		onSuccess: () =>
			qc.invalidateQueries({
				queryKey: ['admin', 'experiments', siteId],
			}),
	});
}

/**
 * End every session one operator holds, via POST /api/users/:id/revoke-sessions (admin token).
 *
 * The id is URL-encoded rather than interpolated raw: it arrives as pasted free text, and a value
 * carrying a `/` or a `?` would otherwise re-point the request at a different route entirely — past
 * the `/api/users/` prefix that `isAdminPath` checks, which is what keeps the admin token off every
 * path that never asked for it.
 *
 * Nothing to invalidate on success: the deployment keeps no session table, so there is no list this
 * changes. The response is the whole of the feedback, and `404` is a distinct outcome rather than an
 * error — see the panel.
 */
export function useRevokeUserSessions(token: string) {
	return useMutation({
		mutationFn: (userId: string) =>
			adminPost<{ user_id: string; sessions_revoked: boolean }>(
				`/api/users/${encodeURIComponent(userId)}/revoke-sessions`,
				token,
				{},
			),
	});
}

/** Set a site's identity tier + salt window via PATCH /api/sites/:id/identity (admin token). */
export function useSetIdentity(token: string, siteId: string) {
	return useMutation({
		mutationFn: (body: SetIdentityInput) =>
			adminPatch<{
				identity: {
					site_id: string;
					tier: IdentityTier;
					salt_window: SaltWindow;
				};
			}>(`/api/sites/${siteId}/identity`, token, body),
	});
}
