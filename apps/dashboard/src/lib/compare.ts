// Period-over-period comparison for BREAKDOWN LISTS (top pages, referrers, countries, devices,
// browsers, OS, networks, languages, regions, screens, channels, events, attribution, revenue).
//
// A breakdown is harder to compare than a KPI, and the difficulty is entirely in what the API does
// NOT tell you. `/api/stats` returns each list already truncated server-side (top 10 paths, top 12
// browsers, top 4 connection tiers …). So a key missing from one period's list means one of two very
// different things:
//
//   • it had NO traffic that period, or
//   • it had traffic, but ranked below the cut.
//
// The list itself distinguishes them only sometimes, and this module never guesses. The cap is not
// sent to the client, but a list SHORTER than its sibling proves it was not truncated: the server
// would have returned more rows if more existed. That gives one provable direction per pair:
//
//   previous.length < current.length  → the previous list was complete → a key absent from it is NEW.
//   current.length  < previous.length → the current list is complete  → a key absent from it is GONE.
//
// When neither holds (both lists at the same length, quite possibly both at the cap) the honest
// reading of a key we cannot find is bounded, not exact: everything in the missing list ranked at or
// below its smallest surviving row. So a current row ABOVE that floor certainly rose — by an unknown
// amount — and is reported as `entered` rather than as a fabricated percentage. A current row below
// the floor could have moved either way, and gets no badge at all.
//
// Everything here is pure so the rules are testable without a server or a render.

import type { CountRow } from '@facet/shared';
import { type MetricDirection, type Movement, countMovement } from './format.js';

/** A key that was in the preceding period's list and is not in the current one. */
export interface DroppedRow {
	key: string;
	/** What it counted in the preceding period. */
	previous: number;
	/** True when the current list is provably complete, so this key really is at zero now. */
	certain: boolean;
}

export interface BreakdownComparison {
	/** Current key → its movement. Keys we cannot honestly compare are simply absent. */
	movements: Map<string, Movement>;
	/** Keys that vanished from the list, worst-first, so a disappearance is visible rather than silent. */
	dropped: DroppedRow[];
}

/** Nothing to compare — a stable identity so callers can render "no deltas" without allocating. */
export const NO_COMPARISON: BreakdownComparison = {
	movements: new Map(),
	dropped: [],
};

/** The smallest count that survived into a list: the ceiling for anything missing from it. */
function floorOf(rows: readonly CountRow[]): number {
	let min = Number.POSITIVE_INFINITY;
	for (const row of rows) min = Math.min(min, row.count);
	return Number.isFinite(min) ? min : 0;
}

/**
 * Compare a breakdown against the same breakdown over the equal-length preceding window.
 *
 * `previous` of null/undefined (query disabled, still loading, failed, or filtered so the windows
 * would not match) yields an empty comparison — every caller then renders the list exactly as it did
 * before deltas existed.
 *
 * Both lists MUST come from the same source measured the same way. Mixing a client-cube breakdown
 * (which counts pageviews) with a server breakdown (which counts events) would produce a percentage
 * that is arithmetic over two different quantities — see the `compare` wiring in the box files.
 */
export function compareBreakdown(
	current: readonly CountRow[],
	previous: readonly CountRow[] | null | undefined,
	direction: MetricDirection = 'up',
): BreakdownComparison {
	if (!previous || previous.length === 0) return NO_COMPARISON;

	const before = new Map(previous.map((row) => [row.key, row.count]));
	const previousComplete = previous.length < current.length;
	const currentComplete = current.length < previous.length;
	const previousFloor = floorOf(previous);

	const movements = new Map<string, Movement>();
	for (const row of current) {
		const was = before.get(row.key);
		if (was !== undefined) {
			const movement = countMovement(row.count, was, direction);
			if (movement) movements.set(row.key, movement);
			continue;
		}
		if (previousComplete) {
			// The preceding list held every key it had, and this one was not among them.
			movements.set(row.key, { kind: 'new', value: 0, sense: 'improvement' });
		} else if (row.count > previousFloor) {
			// It out-ranks the smallest row the preceding list kept, so it certainly rose — but the
			// preceding list may have truncated it, so by how much is unknowable from this response.
			movements.set(row.key, {
				kind: 'entered',
				value: 0,
				sense: 'improvement',
				detail: `the preceding list stopped at ${previousFloor}`,
			});
		}
		// Otherwise: it may have been just below the previous cut, or genuinely new. No badge.
	}

	const now = new Set(current.map((row) => row.key));
	const currentFloor = floorOf(current);
	const dropped: DroppedRow[] = [];
	for (const row of previous) {
		if (now.has(row.key)) continue;
		// Same rule mirrored: only a provably complete current list can call a key gone. Otherwise a
		// key that outranked the current list's smallest surviving row certainly fell out of it —
		// worth showing, labelled as that — while one already below it may not have moved at all.
		if (!currentComplete && row.count <= currentFloor) continue;
		dropped.push({ key: row.key, previous: row.count, certain: currentComplete });
	}
	dropped.sort((a, b) => b.previous - a.previous);

	return { movements, dropped };
}

/** The movement to render for a dropped row: `gone` when provable, `entered`'s mirror when not. */
export function droppedMovement(row: DroppedRow, direction: MetricDirection = 'up'): Movement {
	return row.certain
		? { kind: 'gone', value: 0, sense: direction === 'neutral' ? 'neutral' : 'regression' }
		: {
				kind: 'count',
				value: -row.previous,
				sense: direction === 'neutral' ? 'neutral' : 'regression',
				detail: 'left the top of the list; it may still have traffic below the cut',
			};
}
