// The client compute engine: pure functions over the in-memory dimensional cube. Filtering and
// re-aggregation run entirely on the client (no `arquero`, no `duckdb-wasm` — the cube is a few KB), so
// slicing by device/country/channel re-renders in well under a frame. pageviews/events are additive, so
// they are EXACT under any filter; visitors is COUNT(DISTINCT) per cell and cannot be summed exactly
// across cells, so a multi-cell slice reports an upper bound flagged as approximate.

import type { CountRow, CubeCell } from '@facet/shared';

export interface CubeFilter {
	device?: string;
	country?: string;
	channel?: string;
}

/** The cube axes that can be cross-filtered. */
export type CubeAxis = 'device' | 'country' | 'channel';

/** High-cardinality filters the cube deliberately excludes — applied server-side via a stats refetch. */
export interface ServerFilter {
	path?: string;
	referrer?: string;
}

export interface CubeSlice {
	pageviews: number;
	events: number;
	/** Distinct visitors. Exact when every matched bucket has a single matching cell; otherwise an
	 * upper bound (summing per-cell distinct counts double-counts a visitor spanning cells). */
	visitors: number;
	/** True when `visitors` is a cross-cell upper bound rather than an exact distinct count. */
	visitorsApproximate: boolean;
}

export interface CubeSeriesPoint {
	t: number;
	pageviews: number;
	visitors: number;
}

/** Whether a cell satisfies the (partial) filter — an unset axis matches everything. */
function matches(cell: CubeCell, filter: CubeFilter): boolean {
	return (
		(filter.device === undefined || cell.device === filter.device) &&
		(filter.country === undefined || cell.country === filter.country) &&
		(filter.channel === undefined || cell.channel === filter.channel)
	);
}

/** Distinct values per axis, each ordered by total pageviews descending — for building filter controls. */
export function cubeDimensions(cells: CubeCell[]): {
	device: string[];
	country: string[];
	channel: string[];
} {
	const tally = (key: (c: CubeCell) => string) => {
		const totals = new Map<string, number>();
		for (const c of cells) totals.set(key(c), (totals.get(key(c)) ?? 0) + c.pageviews);
		return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
	};
	return {
		device: tally((c) => c.device),
		country: tally((c) => c.country),
		channel: tally((c) => c.channel),
	};
}

/** A single-axis breakdown (by pageviews, descending) computed from the cube under the CURRENT filter,
 * but ignoring the listed axis's own constraint — so the list keeps showing every value of that axis
 * (with the selected one still present to toggle off) while re-ranking to reflect the other axes. This
 * is the cross-filter contract: pick `mobile` and Top Countries re-ranks to mobile's countries, while
 * Devices still lists all devices with `mobile` highlighted. */
export function cubeBreakdown(cells: CubeCell[], filter: CubeFilter, axis: CubeAxis): CountRow[] {
	const others: CubeFilter = { ...filter, [axis]: undefined };
	const totals = new Map<string, number>();
	for (const c of cells) {
		if (!matches(c, others)) continue;
		totals.set(c[axis], (totals.get(c[axis]) ?? 0) + c.pageviews);
	}
	return [...totals.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([key, count]) => ({ key, count }));
}

/** Filter + aggregate to a summary slice. */
export function sliceCube(cells: CubeCell[], filter: CubeFilter): CubeSlice {
	let pageviews = 0;
	let events = 0;
	let visitors = 0;
	const perBucketCellCount = new Map<number, number>();
	for (const c of cells) {
		if (!matches(c, filter)) continue;
		pageviews += c.pageviews;
		events += c.events;
		visitors += c.visitors;
		perBucketCellCount.set(c.t, (perBucketCellCount.get(c.t) ?? 0) + 1);
	}
	// Visitors is exact only if no bucket had more than one matching cell.
	const visitorsApproximate = [...perBucketCellCount.values()].some((n) => n > 1);
	return { pageviews, events, visitors, visitorsApproximate };
}

/** Filter + re-bucket to a time series (pageviews + visitors per bucket), sorted ascending by time. */
export function cubeSeries(cells: CubeCell[], filter: CubeFilter): CubeSeriesPoint[] {
	const byBucket = new Map<number, { pageviews: number; visitors: number }>();
	for (const c of cells) {
		if (!matches(c, filter)) continue;
		const acc = byBucket.get(c.t) ?? { pageviews: 0, visitors: 0 };
		acc.pageviews += c.pageviews;
		acc.visitors += c.visitors;
		byBucket.set(c.t, acc);
	}
	return [...byBucket.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([t, v]) => ({ t, pageviews: v.pageviews, visitors: v.visitors }));
}

/** True when any axis is constrained. */
export function isFilterActive(filter: CubeFilter): boolean {
	return (
		filter.device !== undefined || filter.country !== undefined || filter.channel !== undefined
	);
}
