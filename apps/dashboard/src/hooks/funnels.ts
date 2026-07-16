// React Query hooks for goals, funnels, conversions, and funnel reports. All go through apiFetch
// (bearer API key). Enabled only once the key + relevant id are present.

import type { Funnel, FunnelReportResult, Goal, GoalConversionResult } from '@countless/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api.js';
import type { Range } from '../state.js';

export function useGoals(apiKey: string, siteId: string) {
	return useQuery({
		queryKey: ['goals', siteId],
		queryFn: () => apiFetch<{ goals: Goal[] }>(`/api/stats/goals?site_id=${siteId}`, apiKey),
		enabled: Boolean(apiKey && siteId),
	});
}

export function useFunnels(apiKey: string, siteId: string) {
	return useQuery({
		queryKey: ['funnels', siteId],
		queryFn: () =>
			apiFetch<{ funnels: Funnel[] }>(`/api/stats/funnels?site_id=${siteId}`, apiKey),
		enabled: Boolean(apiKey && siteId),
	});
}

export function useConversions(apiKey: string, siteId: string, goalId: string, range: Range) {
	return useQuery({
		queryKey: ['conversions', goalId, range],
		queryFn: () =>
			apiFetch<GoalConversionResult>(
				`/api/stats/conversions?site_id=${siteId}&goal_id=${goalId}&start=${range.start}&end=${range.end}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId && goalId),
	});
}

export function useFunnelReport(apiKey: string, siteId: string, funnelId: string, range: Range) {
	return useQuery({
		queryKey: ['funnel-report', funnelId, range],
		queryFn: () =>
			apiFetch<FunnelReportResult>(
				`/api/funnels/${funnelId}/report?site_id=${siteId}&start=${range.start}&end=${range.end}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId && funnelId),
	});
}
