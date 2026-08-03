// Session distribution box: duration and pages-per-session as a box-and-whisker over a violin.
//
// TWO HONESTY OBLIGATIONS this box owns, neither of which belongs in the chart:
//
// 1. THE FILTER MISMATCH. `GET /api/stats/distribution` accepts only `channel`; `event_sessions` is
//    a materialized per-session row with no path, country, device or hostname column, and the route
//    400s rather than answering the unfiltered distribution under a filtered label. The board can
//    have any of those filters active. So the box forwards `channel` and, when any of the others is
//    on, says on screen that this tile is NOT sliced the way the rest of the board is. Passing them
//    would error; dropping them silently would be a lie with a filter chip sitting above it.
//
// 2. SUPPRESSION. Below 25 matching sessions the response carries no statistics at all, and the
//    chart renders the reason rather than an empty box (see `Distribution.tsx`).

import { type ReactElement, useMemo } from 'react';
import { useSessionDistribution } from '../../hooks/insights.js';
import { useDashboard } from '../../state.js';
import { ErrorState, PendingNotice, Skeleton } from '../StatusStates.js';
import { DistributionChart, type DistributionMetric } from '../charts/Distribution.js';
import type { TileConfig, TileDef } from './types.js';

/** Filters the board can carry that this endpoint structurally cannot honour. */
const UNSUPPORTED = ['path', 'referrer', 'country', 'device'] as const;

/**
 * The sentence shown when the board is sliced in a way the session table cannot follow. Returns
 * `null` when the board's filters and this tile's really do agree.
 */
export function filterMismatchNote(active: readonly string[]): string | null {
	if (active.length === 0) return null;
	const list = active.join(', ');
	return `Not sliced by ${list}: sessions are materialized per visit and carry no ${active.length === 1 ? 'such column' : 'such columns'}, so the API refuses that filter rather than answering the unfiltered distribution under a filtered label. Channel filters DO apply.`;
}

function metricOf(config: TileConfig | undefined): DistributionMetric {
	return config?.variant === 'pageviews' ? 'pageviews' : 'duration';
}

function DistributionBody({
	metric,
	channel,
	activeUnsupported,
}: {
	metric: DistributionMetric;
	channel?: string;
	activeUnsupported: string[];
}): ReactElement {
	const { apiKey, siteId, range } = useDashboard();
	const { data, error, isLoading } = useSessionDistribution(apiKey, siteId, range, channel);
	const note = useMemo(() => filterMismatchNote(activeUnsupported), [activeUnsupported]);

	if (isLoading && !data) return <Skeleton className="h-full w-full" />;
	if (error) {
		return (
			<ErrorState message="Could not load the session distribution" detail={String(error)} />
		);
	}
	if (!data) return <ErrorState message="Could not load the session distribution" />;

	return (
		<div className="flex h-full min-h-0 w-full flex-col gap-2">
			{data.meta?.pending ? <PendingNotice /> : null}
			<div className="min-h-0 flex-1">
				<DistributionChart data={data} metric={metric} filterNote={note} />
			</div>
		</div>
	);
}

export const distributionBox: TileDef = {
	id: 'distribution',
	title: 'Session distribution',
	size: 'lg',
	expandable: true,
	variants: [
		{ id: 'duration', label: 'Duration' },
		{ id: 'pageviews', label: 'Pages per session' },
	],
	// No `table`: this box's numbers are not on `ctx`, they come from its own request. The chart
	// already ships every statistic and every bin in its sr-only table, so a second, empty grid here
	// would be worse than none.
	render: (ctx, _expanded, config) => (
		<DistributionBody
			metric={metricOf(config)}
			channel={ctx.cubeFilter.channel}
			activeUnsupported={UNSUPPORTED.filter((key) =>
				key === 'path'
					? Boolean(ctx.serverFilter.path)
					: key === 'referrer'
						? Boolean(ctx.serverFilter.referrer)
						: Boolean(ctx.cubeFilter[key]),
			)}
		/>
	),
};
