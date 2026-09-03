// Timeline-annotation queries. Reading follows the normal site analytics key; mutations use the
// separately-held admin token and invalidate every cached range for that site after success.

import type {
	TimelineAnnotation,
	TimelineAnnotationInput,
	TimelineAnnotationsResponse,
} from '@facet/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminFetch, adminPost } from '../admin.js';
import { apiFetch } from '../api.js';
import { siteQueryKey } from '../lib/queryKeys.js';
import type { Range } from '../state.js';

export function useTimelineAnnotations(
	apiKey: string,
	siteId: string,
	range: Range,
	enabled = true,
) {
	return useQuery({
		queryKey: siteQueryKey('annotations', siteId, range),
		queryFn: () =>
			apiFetch<TimelineAnnotationsResponse>(
				`/api/annotations?site_id=${siteId}&start=${range.start}&end=${range.end}`,
				apiKey,
			),
		enabled: Boolean(siteId) && enabled,
	});
}

export function useCreateTimelineAnnotation(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: TimelineAnnotationInput) =>
			adminPost<{ annotation: TimelineAnnotation }>('/api/annotations', token, body),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['annotations', siteId] }),
	});
}

export function useDeleteTimelineAnnotation(token: string, siteId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			adminFetch<{ deleted: boolean }>(
				`/api/annotations/${encodeURIComponent(id)}?site_id=${siteId}`,
				token,
				{ method: 'DELETE' },
			),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['annotations', siteId] }),
	});
}
