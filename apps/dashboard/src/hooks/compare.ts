// Breakdown comparison consumes the preceding-period slices the Overview already selected.
// Individual boxes never own network reads, so a board with fifteen comparison-capable tiles still
// opens only the requirement-aware requests assembled in App.tsx.

import type { CountRow, StatsResponse } from '@facet/shared';
import { type ReactNode, createContext, createElement, useContext, useMemo } from 'react';
import { type BreakdownComparison, NO_COMPARISON, compareBreakdown } from '../lib/compare.js';
import type { MetricDirection } from '../lib/format.js';

const PreviousPeriodContext = createContext<StatsResponse | null>(null);

export function PreviousPeriodProvider({
	value,
	children,
}: {
	value: StatsResponse | null;
	children: ReactNode;
}): ReactNode {
	return createElement(PreviousPeriodContext.Provider, { value }, children);
}

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
 * The preceding-period slices selected by the active layout. This hook never opens a request: the
 * Overview owns the requirements-aware reads and provides their assembled compatibility shape.
 */
export function usePreviousPeriodStats(): StatsResponse | null {
	return useContext(PreviousPeriodContext);
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
