// React Query hooks for goals, funnels, conversions, and funnel reports. All go through apiFetch
// (bearer API key). Enabled only once the key + relevant id are present.

import type { Funnel, FunnelReportResult, Goal, GoalConversionResult } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api.js';
import { isAuthError } from '../lib/status.js';
import type { Range } from '../state.js';

/**
 * A rejected key never becomes valid by asking again, so an auth failure surfaces its banner on the
 * first response instead of after the default three retries. Everything else gets one retry for a
 * transient blip — the funnels page renders a per-row/per-report error UI, and a page that says
 * "unavailable" quickly is more useful than one that spins.
 */
const retry = (failureCount: number, error: unknown): boolean =>
	!isAuthError(error) && failureCount < 1;

/** Catalog reads only change when someone edits them in Settings; don't re-fetch them per tab visit. */
const CATALOG_STALE_MS = 5 * 60 * 1000;

export function useGoals(apiKey: string, siteId: string) {
	return useQuery({
		queryKey: ['goals', siteId],
		queryFn: () => apiFetch<{ goals: Goal[] }>(`/api/stats/goals?site_id=${siteId}`, apiKey),
		enabled: Boolean(apiKey && siteId),
		staleTime: CATALOG_STALE_MS,
		retry,
	});
}

export function useFunnels(apiKey: string, siteId: string) {
	return useQuery({
		queryKey: ['funnels', siteId],
		queryFn: () =>
			apiFetch<{ funnels: Funnel[] }>(`/api/stats/funnels?site_id=${siteId}`, apiKey),
		enabled: Boolean(apiKey && siteId),
		staleTime: CATALOG_STALE_MS,
		retry,
	});
}

export function useConversions(apiKey: string, siteId: string, goalId: string, range: Range) {
	return useQuery({
		queryKey: ['conversions', siteId, goalId, range],
		queryFn: () =>
			apiFetch<GoalConversionResult>(
				`/api/stats/conversions?site_id=${siteId}&goal_id=${goalId}&start=${range.start}&end=${range.end}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId && goalId),
		retry,
	});
}

export function useFunnelReport(apiKey: string, siteId: string, funnelId: string, range: Range) {
	return useQuery({
		queryKey: ['funnel-report', siteId, funnelId, range],
		queryFn: () =>
			apiFetch<FunnelReportResult>(
				`/api/funnels/${funnelId}/report?site_id=${siteId}&start=${range.start}&end=${range.end}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId && funnelId),
		retry,
	});
}
