// A ranked list that knows what it looked like last period.
//
// Two components on purpose. `BreakdownList` is the entry point every caller uses; it renders a plain
// `TopList` when no comparison source was supplied and `ComparedList` when one was. That branch is
// static per call site, and it is what keeps the compare hooks — react-query plus the dashboard store
// — out of every render path that has neither: a `TopList` in Realtime, or a tile rendered in a test,
// must not acquire a data dependency just because a sibling wanted deltas.
//
// Disappearances live here too. A key that was in last period's list and is not in this one cannot be
// shown as a row with a delta (it has no current row), so it would silently vanish — precisely the
// movement a reader most wants to see. `DroppedRows` appends those keys under the list, muted, with
// their previous figure and an honest label: "gone" when the current list provably holds everything,
// "left the top" when the list may simply have truncated them. Compact tiles are height-fitted and
// have no room for that, so it is shown in the expanded drill-down where the reader is investigating.

import type { ReactElement } from 'react';
import { type CompareSource, useBreakdownComparison } from '../hooks/compare.js';
import { type DroppedRow, droppedMovement } from '../lib/compare.js';
import { formatNumber } from '../lib/format.js';
import { DeltaBadge } from './Delta.js';
import { TopList } from './TopList.js';

type TopListProps = Parameters<typeof TopList>[0];

export interface BreakdownListProps extends TopListProps {
	/** Where the preceding period's rows come from. Omit for a list with no honest comparison. */
	compare?: CompareSource | null;
	/** Show the keys that fell out of the list. Off by default — compact tiles have no room. */
	showDropped?: boolean;
}

/** The keys that left the list, with what they were worth before. */
function DroppedRows({ rows }: { rows: readonly DroppedRow[] }): ReactElement | null {
	if (rows.length === 0) return null;
	return (
		<div className="mt-2 border-[color:rgb(var(--border))] border-t pt-2">
			<p
				data-chrome
				className="text-[10px] text-[color:var(--faint)] uppercase tracking-wide"
			>
				No longer here
			</p>
			<ul className="mt-1 space-y-0.5">
				{rows.map((row) => (
					<li
						key={row.key}
						className="flex items-baseline justify-between gap-3 px-2.5 py-1 text-sm"
					>
						<span
							className="min-w-0 truncate text-[color:var(--muted)]"
							title={row.key}
						>
							{row.key}
						</span>
						<span className="flex shrink-0 items-baseline gap-1.5">
							<span className="text-[11px] text-[color:var(--faint)] tabular-nums">
								was {formatNumber(row.previous)}
							</span>
							<DeltaBadge movement={droppedMovement(row)} size="sm" />
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** The comparing variant: owns the (shared, already-in-flight) preceding-period query. */
function ComparedList({
	compare,
	showDropped,
	...list
}: BreakdownListProps & { compare: CompareSource }): ReactElement {
	const { movements, dropped } = useBreakdownComparison(compare);
	return (
		<TopList
			{...list}
			deltas={movements}
			trailing={showDropped ? <DroppedRows rows={dropped} /> : null}
		/>
	);
}

export function BreakdownList({
	compare,
	showDropped = false,
	...list
}: BreakdownListProps): ReactElement {
	if (!compare) return <TopList {...list} />;
	return <ComparedList compare={compare} showDropped={showDropped} {...list} />;
}

export { DroppedRows };
