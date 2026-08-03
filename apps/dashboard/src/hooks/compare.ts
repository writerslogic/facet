// Breakdown comparison, wired to the query the Overview ALREADY makes.
//
// Cost is the whole design constraint here. The Overview fetches the equal-length preceding window
// once (see `compareQuery` in App.tsx) to put deltas on the three KPI tiles, and that single response
// carries every breakdown list too — top_paths, top_referrers, top_countries, the lot. So the fifteen
// list tiles need no query of their own: this hook rebuilds the SAME `StatsQuery` value from the same
// store, hands it to the same `useCompareStats`, and lands on the same react-query cache entry
// (`['stats-compare', query]`, hashed by value). Fifteen callers, zero extra requests. Nothing here
// runs on any other tab, because nothing here is mounted on any other tab.
//
// The gate is copied from the Overview deliberately: a segment that filters the current numbers is
// NOT applied to the comparison window (device/country/channel are sliced client-side from the cube;
// path/referrer re-query the server), so while one is active the Overview does not fetch a comparison
// at all — and this hook must not either. A delta computed from an unfiltered preceding period next
// to a filtered current period would be worse than no delta.

import type { CountRow, StatsQuery, StatsResponse } from '@facet/shared';
import { useMemo } from 'react';
import { type BreakdownComparison, NO_COMPARISON, compareBreakdown } from '../lib/compare.js';
import { isFilterActive } from '../lib/cube.js';
import type { MetricDirection } from '../lib/format.js';
import { needsServer, toCubeFilter } from '../lib/segment.js';
import { useDashboard } from '../state.js';
import { useSegment } from './segment.js';
import { useCompareStats } from './stats.js';

/**
 * Where a list's comparison rows come from. `current` must be measured exactly like `select`'s
 * output — both sides of a percentage have to count the same thing (see lib/compare.ts).
 */
export interface CompareSource {
	current: readonly CountRow[];
	select: (previous: StatsResponse) => readonly CountRow[] | undefined;
	/** Which way is "good" for this dimension. Breakdowns are volume, so up by default. */
	direction?: MetricDirection;
	/** Appended to every movement's tooltip when the compared measure differs from the displayed one. */
	note?: string;
}

/**
 * The preceding-period stats response for the Overview's window, or null when there is none to be
 * had: no site, or a segment is active (see above). Never throws and never fetches on its own — if
 * the Overview did not ask for this window, neither does this.
 */
export function usePreviousPeriodStats(): StatsResponse | null {
	const { apiKey, siteId, preset, range } = useDashboard();
	const { segment } = useSegment();

	// Same three lines as the Overview: a cube slice or a server drill-down both mean "the comparison
	// window is not narrowed the same way", which disables the comparison entirely.
	const serverMode = needsServer(segment);
	const cubeActive = isFilterActive(toCubeFilter(segment)) && !serverMode;
	const filtered = cubeActive || serverMode;

	const span = range.end - range.start;
	const query: StatsQuery = {
		site_id: siteId,
		start: range.start - span,
		end: range.start,
		interval: preset === '24h' ? 'hour' : 'day',
	};
	// Strictly narrower than the Overview's own gate (which omits the site check), so this can only
	// ever read a cache entry the Overview already asked for — never open a request of its own.
	const enabled = Boolean(siteId) && !filtered;
	const { data } = useCompareStats(apiKey, query, enabled);
	return enabled ? (data ?? null) : null;
}

/**
 * The movements for one breakdown list. Returns the empty comparison whenever the preceding window
 * is unavailable — disabled, loading, failed, or filtered — so a list simply renders without deltas.
 */
export function useBreakdownComparison(
	source: CompareSource | null | undefined,
): BreakdownComparison {
	const previous = usePreviousPeriodStats();
	const current = source?.current;
	const select = source?.select;
	const direction = source?.direction ?? 'up';
	const note = source?.note;
	return useMemo(() => {
		if (!current || !select || !previous) return NO_COMPARISON;
		const comparison = compareBreakdown(current, select(previous), direction);
		if (!note) return comparison;
		// A list whose displayed figures are measured differently from the compared ones (the cube
		// dimensions: the board draws pageviews, the comparison counts events) says so in the tooltip
		// rather than leaving the reader to assume the percentage restates the number beside it.
		const annotated = new Map(
			[...comparison.movements].map(([key, movement]) => [
				key,
				{ ...movement, detail: movement.detail ? `${movement.detail}; ${note}` : note },
			]),
		);
		return { movements: annotated, dropped: comparison.dropped };
	}, [current, select, previous, direction, note]);
}
