// The current SEGMENT: one cross-filter, shared by every tab.
//
// The cross-filter used to be two `useState`s inside `Dashboard()` (a cube filter and a server
// filter) that only the Overview read, so a segment died the moment you left that tab. This module
// is the single home for "what am I looking at": the value, the transitions over it (a pure
// reducer), the URL codec that makes it shareable, and — critically — the table of WHICH TABS CAN
// ACTUALLY HONOUR IT.
//
// The five keys are exactly the exact-match dimension filters `StatsQuerySchema` accepts, so a
// segment maps onto a `StatsQuery` without translation. Splitting them into "cube axes" (sliced in
// the browser from the in-memory cube) and "server axes" (high-cardinality, refetched) is a
// transport detail, kept here as two projections rather than two pieces of state.

import type { CubeFilter, ServerFilter } from './cube.js';

export interface Segment {
	device?: string;
	country?: string;
	channel?: string;
	path?: string;
	referrer?: string;
}

export type SegmentKey = keyof Segment;

/** The cube's low-cardinality axes: sliced client-side, no server round-trip. */
export const CUBE_KEYS = ['device', 'country', 'channel'] as const;

/** High-cardinality axes the cube deliberately excludes: only the server can narrow these. */
export const SERVER_KEYS = ['path', 'referrer'] as const;

/** Display order: cube axes first (they are the cheap ones), then the server drill-downs. */
export const SEGMENT_KEYS: readonly SegmentKey[] = [...CUBE_KEYS, ...SERVER_KEYS];

export const SEGMENT_LABELS: Record<SegmentKey, string> = {
	device: 'Device',
	country: 'Country',
	channel: 'Channel',
	path: 'Path',
	referrer: 'Referrer',
};

/**
 * Per-key value caps, mirroring `StatsQuerySchema` in packages/shared. A segment can arrive from the
 * URL, which is untrusted input: an over-long value would fail validation server-side and 400 every
 * read on the board, so it is dropped at the door instead.
 */
export const SEGMENT_MAX_LEN: Record<SegmentKey, number> = {
	device: 20,
	country: 8,
	channel: 40,
	path: 2048,
	referrer: 2048,
};

/** Stable empty reference so `segment === EMPTY_SEGMENT` short-circuits and memo keys stay stable. */
export const EMPTY_SEGMENT: Segment = {};

export function isSegmentActive(segment: Segment): boolean {
	return SEGMENT_KEYS.some((key) => segment[key] !== undefined);
}

/** The active constraints, in display order — what the filter chips render from. */
export function segmentEntries(
	segment: Segment,
): { key: SegmentKey; label: string; value: string }[] {
	return SEGMENT_KEYS.filter((key) => segment[key] !== undefined).map((key) => ({
		key,
		label: SEGMENT_LABELS[key],
		value: segment[key] as string,
	}));
}

/** The cube-sliceable projection (device/country/channel). */
export function toCubeFilter(segment: Segment): CubeFilter {
	return {
		device: segment.device,
		country: segment.country,
		channel: segment.channel,
	};
}

/** The server-only projection (path/referrer). */
export function toServerFilter(segment: Segment): ServerFilter {
	return { path: segment.path, referrer: segment.referrer };
}

/** True when the segment names a high-cardinality axis, which forces a server refetch. */
export function needsServer(segment: Segment): boolean {
	return SERVER_KEYS.some((key) => segment[key] !== undefined);
}

/** Only the defined keys, for spreading into a `StatsQuery` (an explicit `undefined` would still
 * serialize as a key on some code paths, and `qs()` is happier with an absent key). */
export function segmentParams(segment: Segment): Segment {
	const out: Segment = {};
	for (const key of SEGMENT_KEYS) {
		const value = segment[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Transitions

export type SegmentAction =
	| { type: 'set'; segment: Segment }
	/** Click-to-filter: selecting the value already in force removes it (the Overview contract). */
	| { type: 'toggle'; key: SegmentKey; value: string }
	| { type: 'remove'; key: SegmentKey }
	| { type: 'clear' };

/** Pure transition function. Returns the SAME object when nothing changed so React can bail out. */
export function segmentReducer(state: Segment, action: SegmentAction): Segment {
	switch (action.type) {
		case 'set': {
			const next = segmentParams(action.segment);
			return sameSegment(state, next) ? state : next;
		}
		case 'toggle': {
			const current = state[action.key];
			const next = segmentParams({
				...state,
				[action.key]: current === action.value ? undefined : action.value,
			});
			return sameSegment(state, next) ? state : next;
		}
		case 'remove': {
			if (state[action.key] === undefined) return state;
			return segmentParams({ ...state, [action.key]: undefined });
		}
		case 'clear':
			return isSegmentActive(state) ? EMPTY_SEGMENT : state;
	}
}

/** Value equality over the five keys. */
export function sameSegment(a: Segment, b: Segment): boolean {
	return SEGMENT_KEYS.every((key) => a[key] === b[key]);
}

// ---------------------------------------------------------------------------
// URL

/**
 * Parse a segment from a querystring. Each key carries its own value verbatim (`?device=mobile`),
 * matching the API's own parameter names so a dashboard link and an API call read the same.
 *
 * Follows `readSelectionFromUrl` in state.ts: read once at mount, validate, fall back to nothing.
 * Empty and over-long values are dropped rather than trusted — see SEGMENT_MAX_LEN.
 */
export function readSegmentFromUrl(search: string = window.location.search): Segment {
	const params = new URLSearchParams(search);
	const segment: Segment = {};
	for (const key of SEGMENT_KEYS) {
		const raw = params.get(key);
		if (raw === null) continue;
		if (raw.length === 0 || raw.length > SEGMENT_MAX_LEN[key]) continue;
		segment[key] = raw;
	}
	return segment;
}

/**
 * Reflect the segment into the URL, in place. Mirrors `writeSelectionToUrl` in state.ts: build from
 * the CURRENT href and set/delete only our own keys, so the range params written by the other writer
 * survive untouched (and vice versa). `replaceState`, not `pushState` — a filter click is not a
 * navigation, and the range control already made that call.
 */
export function writeSegmentToUrl(segment: Segment): void {
	const url = new URL(window.location.href);
	for (const key of SEGMENT_KEYS) {
		const value = segment[key];
		if (value === undefined) url.searchParams.delete(key);
		else url.searchParams.set(key, value);
	}
	window.history.replaceState(null, '', url);
}

// ---------------------------------------------------------------------------
// Which tabs can honour a segment — verified endpoint by endpoint

/** The tabs that render data (Documentation has none, so it makes no claim). */
export type SegmentTab =
	| 'overview'
	| 'explore'
	| 'realtime'
	| 'funnels'
	| 'retention'
	| 'experiments'
	| 'anomalies'
	| 'crm'
	| 'ask';

/**
 * `full`   — every number on the tab is scoped to the segment.
 * `partial`— some numbers are, some structurally cannot be; the note says which is which.
 * `none`   — nothing on the tab is scoped; the numbers cover ALL traffic.
 */
export type SegmentSupport = 'full' | 'partial' | 'none';

export interface TabSegmentSupport {
	level: SegmentSupport;
	/** Shown verbatim to the reader whenever a segment is active on that tab. */
	note: string;
}

/**
 * The honesty table. Every entry below was checked against apps/server/src/routes/stats.ts,
 * routes/funnels.ts and the db helpers they call — NOT against `StatsQuerySchema`, which several of
 * these endpoints validate against while their SQL then ignores the dimension fields entirely:
 *
 *   /api/stats            → toStatsFilter → buildFilteredEventWhere: applies all five. FULL.
 *   /api/stats/breakdown  → breakdown() applies all five on BOTH paths: `d1Breakdown` through
 *                           buildFilteredEventWhere, and `aeWhere` through the mirrored blob column
 *                           each key narrows — and the columnar path DECLINES to D1 rather than
 *                           dropping a filter term it cannot express. FULL.
 *   /api/stats/cube       → cube() uses buildEventWhere on purpose; the client slices the result.
 *   /api/stats/realtime   → realtime(env, siteId, …): site + trailing window only. NO filter.
 *   /api/stats/retention  → cohortRetention() reads `sessions` by siteId + firstSeen only. It
 *                           accepts path/country/device/channel and DISCARDS them. NO filter.
 *   /api/stats/anomalies  → detectAnomalies() uses buildEventWhere (unfiltered). NO filter.
 *   /api/funnels/:id/report and /api/stats/conversions → no dimension params at all. NO filter.
 *   /api/stats/experiment → experimentResult() scopes by siteId + range only. NO filter.
 *   /api/stats/query      → the executor is handed { siteId, start, end }. NO filter.
 *   /api/crm/*            → a contact's activity is every event its consent-verified visitor hashes
 *                           produced; contactActivity() takes siteId + hashes and nothing else, and
 *                           there is no date range either. NO filter.
 *
 * A tab whose level is not `full` must render this note next to its numbers. Showing filtered
 * labels over unfiltered numbers is the one outcome worse than not filtering at all.
 */
export const TAB_SEGMENT_SUPPORT: Record<SegmentTab, TabSegmentSupport> = {
	overview: {
		level: 'full',
		note: 'Every tile is scoped to this segment. Device, country and channel slice in the browser; path and referrer re-query the server.',
	},
	explore: {
		level: 'full',
		note: 'Every group below is scoped to this segment. The breakdown endpoint applies all five dimensions, and the columnar store falls back to D1 rather than answering with a filter dropped.',
	},
	realtime: {
		level: 'partial',
		note: 'The live breakdowns below are scoped to this segment. The two counters are not: the realtime endpoint takes no dimension filters, so they count all traffic in the window.',
	},
	funnels: {
		level: 'none',
		note: 'Not applied. Goal conversions and funnel reports are computed per session over the whole site — those endpoints take no dimension filters — so the numbers below cover all traffic.',
	},
	retention: {
		level: 'none',
		note: 'Not applied. Cohorts are built from first-seen visitor hashes for the whole site; the retention endpoint accepts dimension parameters but ignores them, so the triangle below covers all traffic.',
	},
	experiments: {
		level: 'none',
		note: 'Not applied. Variant exposures and conversions are counted across the whole site — that endpoint takes no dimension filters — so the results below cover all traffic.',
	},
	anomalies: {
		level: 'none',
		note: 'Not applied. Detection scores site-wide hourly pageviews against their own baseline, so the anomalies below cover all traffic.',
	},
	crm: {
		level: 'none',
		note: "Not applied, and there is no date range either. A contact's activity is every event Facet is allowed to attribute to them, for as long as their consent record reaches back.",
	},
	ask: {
		level: 'none',
		note: 'Not applied. Questions are answered over the whole site for the chosen window, so the answer below covers all traffic.',
	},
};
