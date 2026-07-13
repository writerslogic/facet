// Dashboard API client: typed fetch wrappers around the Countless stats endpoints. Uses the
// shared response types so the UI and Worker never drift. Real calls land in T021.

import type { StatsQuery, StatsResponse } from '@countless/shared';

/** Fetch the summary + series + top-N stats for a site. */
export async function fetchStats(_apiKey: string, _query: StatsQuery): Promise<StatsResponse> {
	return {
		summary: { pageviews: 0, visitors: 0, events: 0 },
		series: [],
		top_paths: [],
		top_referrers: [],
		top_events: [],
	};
}
