// React Query hooks for the admin feature-flags API (Bearer ADMIN_TOKEN). All calls go through
// adminFetch/adminPost/adminPatch which refuse any non-admin path. Mutations invalidate the matching
// list query so the panel refreshes without a full page reload. The admin token is never placed in a
// query key or URL.

import type { FlagInput, FlagRecord } from '@facet/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminFetch, adminPatch, adminPost } from '../admin.js';

export function useAdminFlags(token: string, siteId: string) {
	return useQuery({
		queryKey: ['admin', 'flags', siteId],
		queryFn: () => adminFetch<{ flags: FlagRecord[] }>(`/api/flags?site_id=${siteId}`, token),
		enabled: Boolean(token && siteId),
	});
}

export function useCreateFlag(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: FlagInput) => adminPost<{ flag: FlagRecord }>('/api/flags', token, body),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'flags', siteId] }),
	});
}

export function useUpdateFlag(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, body }: { id: string; body: FlagInput }) =>
			adminPatch<{ flag: FlagRecord }>(`/api/flags/${id}`, token, body),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'flags', siteId] }),
	});
}

export function useDeleteFlag(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			adminFetch<{ deleted: boolean }>(`/api/flags/${id}?site_id=${siteId}`, token, {
				method: 'DELETE',
			}),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'flags', siteId] }),
	});
}
