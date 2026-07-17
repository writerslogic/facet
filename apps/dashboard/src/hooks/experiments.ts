// React Query hooks for experiments: enumerate a site's experiments via the API-key catalog
// endpoint, and fetch a single experiment's per-variant significance result for a chosen goal.

import type { Experiment, ExperimentResult, Goal } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api.js';
import type { Range } from '../state.js';

export function useExperiments(apiKey: string, siteId: string) {
	return useQuery({
		queryKey: ['experiments', siteId],
		queryFn: () =>
			apiFetch<{ experiments: Experiment[] }>(
				`/api/stats/experiments?site_id=${siteId}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId),
	});
}

export function useExperimentResult(
	apiKey: string,
	siteId: string,
	experimentId: string,
	goal: Goal | null,
	range: Range,
) {
	return useQuery({
		queryKey: ['experiment-result', experimentId, goal?.id, range],
		queryFn: () =>
			apiFetch<ExperimentResult>(
				`/api/stats/experiment?site_id=${siteId}&experiment_id=${experimentId}&goal_type=${goal?.type}&goal_value=${encodeURIComponent(goal?.match_value ?? '')}&start=${range.start}&end=${range.end}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId && experimentId && goal),
	});
}
