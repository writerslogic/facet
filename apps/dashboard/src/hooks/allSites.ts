// Cross-site roll-up: one stats read per saved profile, fanned out with `useQueries`.
//
// An API key is bound to exactly one site (the server answers `site_mismatch` for any other), so
// there is no "give me every site" endpoint to call — the only correct shape is N independent
// requests, each carrying its own profile's key. `useQueries` gives every site its own cache entry,
// its own error and its own refetch, which is exactly the isolation this view needs: a revoked key
// on one site must cost that row and nothing else.
//
// These use the narrow core response rather than sharing the full Overview cache: returning only
// summary + series avoids paying for every optional tile twice per site.

import type { SeriesPoint, StatsCoreResponse, StatsQuery, StatsSummary } from '@facet/shared';
import { useQueries } from '@tanstack/react-query';
import { apiFetch, qs } from '../api.js';
import { type Delta, computeDelta } from '../lib/format.js';
import { siteQueryKey } from '../lib/queryKeys.js';
import { isAuthError } from '../lib/status.js';
import type { Profile, Range } from '../state.js';

/** Per-row read state. Mirrors `lib/status.ts` minus `empty`: a site reporting zeros is a real row. */
export type RowStatus = 'loading' | 'auth-error' | 'error' | 'success';

/** The three headline metrics, each with its period-over-period delta (null when uncomparable). */
export interface RowDeltas {
	pageviews: Delta | null;
	visitors: Delta | null;
	events: Delta | null;
}

/** One site's row in the roll-up. */
export interface SiteRollup {
	profile: Profile;
	status: RowStatus;
	/** The failure for this row only, when `status` is an error. Never contains the API key. */
	error: Error | null;
	summary: StatsSummary | null;
	series: SeriesPoint[];
	deltas: RowDeltas;
	/** A background refetch is in flight (row keeps its numbers, shows a subtle busy hint). */
	isFetching: boolean;
	/** Retry this site alone — both its current and its comparison window. */
	retry: () => void;
}

/**
 * The all-sites aggregate.
 *
 * `pageviews` and `events` are honest sums: both count occurrences, and an occurrence belongs to
 * exactly one site, so adding them across sites double-counts nothing.
 *
 * `visitorsUpperBound` is NOT a total and is never called one. A site's `visitors` is a count of
 * distinct salted visitor hashes *within that site*; the salt is per-site, so one person browsing
 * two sites is two hashes. Summing therefore yields an upper bound (the true number of people is
 * somewhere between the largest single site and this sum). It is exposed under a name that cannot
 * be mistaken for a total, and the UI labels it as a bound.
 */
export interface SitesAggregate {
	/** Sites contributing to these figures (i.e. that loaded). */
	loaded: number;
	/** Sites in the roll-up overall — `loaded < total` means the figures are partial. */
	total: number;
	pageviews: number;
	events: number;
	/** Sum of per-site distinct-visitor counts. An upper bound on people, never a total. */
	visitorsUpperBound: number;
	/** Deltas over the summable metrics, and only when EVERY loaded site also has a comparison —
	 * otherwise the two windows would cover different sets of sites. */
	pageviewsDelta: Delta | null;
	eventsDelta: Delta | null;
	/** Combined pageview trend, summed per bucket timestamp (not per index: a site with no data has a
	 * shorter series, and index-aligning would smear buckets together). */
	pageviewSpark: number[];
}

function statsQuery(profile: Profile, range: Range, interval: 'hour' | 'day'): StatsQuery {
	return { site_id: profile.siteId, start: range.start, end: range.end, interval };
}

/** The equal-length window immediately before `range`, for period-over-period deltas. */
function previousWindow(range: Range): Range {
	const span = range.end - range.start;
	return { start: range.start - span, end: range.start };
}

/** Retrying a rejected key just burns requests — the fix is editing the profile, not waiting. */
function retryPolicy(count: number, error: Error): boolean {
	return !isAuthError(error) && count < 1;
}

function toStatus(isPending: boolean, error: Error | null): RowStatus {
	if (error) return isAuthError(error) ? 'auth-error' : 'error';
	return isPending ? 'loading' : 'success';
}

/**
 * Fan out one core read (plus one comparison read) per profile.
 *
 * Current and comparison are separate queries on purpose: if a site's comparison window fails, the
 * row still shows this period's numbers without deltas, rather than the whole row collapsing.
 */
export function useAllSitesRollup(
	profiles: Profile[],
	range: Range,
	interval: 'hour' | 'day',
): SiteRollup[] {
	const enabled = range.end > range.start;
	const current = useQueries({
		queries: profiles.map((profile) => {
			const query = statsQuery(profile, range, interval);
			return {
				queryKey: siteQueryKey('stats-core', profile.siteId, query),
				queryFn: () =>
					apiFetch<StatsCoreResponse>(`/api/stats/core?${qs(query)}`, profile.apiKey),
				enabled: Boolean(profile.siteId) && enabled,
				retry: retryPolicy,
			};
		}),
	});
	const compare = useQueries({
		queries: profiles.map((profile) => {
			const query = statsQuery(profile, previousWindow(range), interval);
			return {
				queryKey: siteQueryKey('stats-core-compare', profile.siteId, query),
				queryFn: () =>
					apiFetch<StatsCoreResponse>(`/api/stats/core?${qs(query)}`, profile.apiKey),
				enabled: Boolean(profile.siteId) && enabled,
				retry: retryPolicy,
			};
		}),
	});

	return profiles.map((profile, i) => {
		const now = current[i];
		const before = compare[i];
		const error = (now?.error as Error | undefined) ?? null;
		const summary = now?.data?.summary ?? null;
		const prev = before?.data?.summary ?? null;
		const deltas: RowDeltas =
			summary && prev
				? {
						pageviews: computeDelta(summary.pageviews, prev.pageviews),
						visitors: computeDelta(summary.visitors, prev.visitors),
						events: computeDelta(summary.events, prev.events),
					}
				: { pageviews: null, visitors: null, events: null };
		return {
			profile,
			status: toStatus(now?.isPending ?? true, error),
			error,
			summary,
			series: now?.data?.series ?? [],
			deltas,
			isFetching: Boolean(now?.isFetching) && summary !== null,
			retry: () => {
				void now?.refetch();
				void before?.refetch();
			},
		};
	});
}

/** Sum the summable metrics across the rows that loaded, and bound the un-summable one. */
export function aggregateRollups(rows: SiteRollup[]): SitesAggregate {
	const loaded = rows.filter((row) => row.summary !== null);
	// A delta needs both windows for the SAME set of sites; if any loaded site lacks a comparison the
	// aggregate delta would compare "these 3 sites now" against "those 2 sites before".
	const comparable = loaded.every((row) => row.deltas.pageviews !== null);
	const sum = (pick: (s: StatsSummary) => number): number =>
		loaded.reduce((acc, row) => acc + (row.summary ? pick(row.summary) : 0), 0);
	// current - absolute recovers the previous value without re-plumbing the compare responses.
	const previousOf = (pick: (d: RowDeltas) => Delta | null): number =>
		loaded.reduce((acc, row) => acc + (pick(row.deltas)?.absolute ?? 0), 0);

	const pageviews = sum((s) => s.pageviews);
	const events = sum((s) => s.events);

	// Bucket-aligned sum of the pageview series: keyed by timestamp so sites with gaps still line up.
	const byBucket = new Map<number, number>();
	for (const row of loaded) {
		for (const point of row.series) {
			byBucket.set(point.t, (byBucket.get(point.t) ?? 0) + point.pageviews);
		}
	}
	const pageviewSpark = [...byBucket.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, value]) => value);

	return {
		loaded: loaded.length,
		total: rows.length,
		pageviews,
		events,
		visitorsUpperBound: sum((s) => s.visitors),
		pageviewsDelta:
			comparable && loaded.length > 0
				? computeDelta(pageviews, pageviews - previousOf((d) => d.pageviews))
				: null,
		eventsDelta:
			comparable && loaded.length > 0
				? computeDelta(events, events - previousOf((d) => d.events))
				: null,
		pageviewSpark,
	};
}

/** Columns the roll-up can be ordered by. `site` sorts on the profile label. */
export type SortKey = 'site' | 'pageviews' | 'visitors' | 'events';
export type SortDir = 'asc' | 'desc';

function metricOf(row: SiteRollup, key: SortKey): number | null {
	if (!row.summary) return null;
	if (key === 'pageviews') return row.summary.pageviews;
	if (key === 'visitors') return row.summary.visitors;
	if (key === 'events') return row.summary.events;
	return null;
}

/**
 * Sort a copy of the rows. Rows with no numbers yet (loading or failed) always sink to the bottom in
 * their original order, whichever direction is active: an ascending sort must not float a broken
 * site to the top, where it would read as "this site has the fewest pageviews".
 */
export function sortRollups(rows: SiteRollup[], key: SortKey, dir: SortDir): SiteRollup[] {
	const sign = dir === 'asc' ? 1 : -1;
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => {
			const aHas = a.row.summary !== null;
			const bHas = b.row.summary !== null;
			if (aHas !== bHas) return aHas ? -1 : 1;
			if (!aHas) return a.index - b.index;
			if (key === 'site') {
				return sign * a.row.profile.label.localeCompare(b.row.profile.label);
			}
			const av = metricOf(a.row, key) ?? 0;
			const bv = metricOf(b.row, key) ?? 0;
			if (av === bv) return a.index - b.index;
			return sign * (av - bv);
		})
		.map((entry) => entry.row);
}
