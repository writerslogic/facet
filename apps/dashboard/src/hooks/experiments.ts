// React Query hooks for experiments: enumerate a site's experiments via the API-key catalog
// endpoint, and fetch a single experiment's per-variant significance result for a chosen goal.

import type { Experiment, ExperimentResult, Goal } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api.js';
import { siteQueryKey } from '../lib/queryKeys.js';
import type { Range } from '../state.js';

export function useExperiments(apiKey: string, siteId: string) {
	return useQuery({
		queryKey: siteQueryKey('experiments', siteId),
		queryFn: () =>
			apiFetch<{ experiments: Experiment[] }>(
				`/api/stats/experiments?${new URLSearchParams({ site_id: siteId })}`,
				apiKey,
			),
		enabled: Boolean(apiKey && siteId),
		// The catalog only changes when someone edits it in Settings, so don't re-fetch it every
		// time the tab regains focus while a reader is comparing variants.
		staleTime: 60_000,
	});
}

export function useExperimentResult(
	apiKey: string,
	siteId: string,
	experimentId: string,
	goal: Goal | null,
	range: Range,
	/** The caller's own gate, ANDed with the key/site/experiment/goal checks. The period-comparison
	 * caller uses it to NOT query a window the experiment did not exist for — see Experiments.tsx. */
	enabled = true,
) {
	// URLSearchParams rather than manual interpolation: goal match values are user-authored strings
	// (paths, event names) and every param has to survive the server's query validation intact.
	const params = new URLSearchParams({
		site_id: siteId,
		experiment_id: experimentId,
		goal_type: goal?.type ?? '',
		goal_value: goal?.match_value ?? '',
		start: String(range.start),
		end: String(range.end),
	}).toString();

	return useQuery({
		queryKey: siteQueryKey('experiment-result', siteId, experimentId, goal?.id, range),
		queryFn: () => apiFetch<ExperimentResult>(`/api/stats/experiment?${params}`, apiKey),
		enabled: Boolean(apiKey && siteId && experimentId && goal) && enabled,
		// A date-range change re-queries the same experiment + goal: keep the current table on screen
		// instead of dropping to a skeleton (the view dims it while it is stale). Deliberately scoped
		// to the same site, experiment AND goal — showing one experiment's or one goal's rates under
		// another's label would be a lie, so those swaps fall through to undefined → skeleton.
		placeholderData: (prev, prevQuery) => {
			const [, prevSite, prevExp, prevGoal] = (prevQuery?.queryKey ?? []) as unknown[];
			return prevSite === siteId && prevExp === experimentId && prevGoal === goal?.id
				? prev
				: undefined;
		},
	});
}
