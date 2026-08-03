// Visualization-shaped aggregates that the cube and the flat top-N lists cannot express: session
// distributions, per-dimension time series, the URL-prefix tree, entry→exit journeys, and the
// UTC clock grid. Sibling of `stats.ts` — same conventions (Drizzle `sql` helpers, unix-ms ranges
// half-open on [start, end), no raw table-name SQL), split out because these are chart contracts
// rather than the headline metrics.
//
// Two rules hold across the whole file:
//   1. Every response is bounded by a constant, never by the data. A site with a million distinct
//      URLs and a site with ten produce the same maximum response size.
//   2. Aggregation happens in SQL. The only JS-side work is assembling already-grouped rows into a
//      tree / grid / zero-filled series — all over sets the SQL already bounded.

import {
	type ClockCell,
	type ClockResponse,
	type DimensionSeries,
	type DimensionSeriesPoint,
	type DimensionSeriesResponse,
	type DistributionBucket,
	type DistributionPercentile,
	type Interval,
	type JourneyPair,
	type JourneysResponse,
	type MetricDistribution,
	type PathTreeNode,
	type PathTreeResponse,
	SERIES_MAX_KEYS,
	type SeriesDimension,
	type SessionDistributionResponse,
	type StatsFilter,
} from '@facet/shared';
import { type SQL, and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Env } from '../env.js';
import { DAY_MS, HOUR_MS } from '../lib/constants.js';
import { db } from './queries.js';
import * as schema from './schema.js';
import {
	K_ANON,
	buildFilteredEventWhere,
	buildSessionWhere,
	eventCount,
	pageviewCount,
	sessionFreshness,
} from './stats.js';

// ── 1. Session distribution ───────────────────────────────────────────────────────────────────────

/**
 * Minimum sessions before ANY distribution statistic is emitted.
 *
 * Deliberately higher than `K_ANON`. A breakdown row leaks one number per key; a distribution leaks
 * eleven order statistics (min, max, 8 percentiles, mean) plus a histogram. Below ~11 observations
 * the percentile vector simply IS the raw sample re-encoded — the exact per-session data this
 * endpoint refuses to return. 25 is double the count of emitted order statistics, so even the
 * finest reported level (p05 / p99) aggregates over several sessions and no returned number can be
 * pinned to one visit.
 */
export const K_ANON_DISTRIBUTION = 25;

/** The percentile levels reported, ascending. See `MetricDistribution` for the nearest-rank-lower
 * definition — the value at 0-based index `floor(p * (n - 1))` of the ascending sample. */
const PERCENTILES: readonly (readonly [DistributionPercentile, number])[] = [
	['p05', 0.05],
	['p10', 0.1],
	['p25', 0.25],
	['p50', 0.5],
	['p75', 0.75],
	['p90', 0.9],
	['p95', 0.95],
	['p99', 0.99],
];

/** Upper edges for the session-duration histogram, in ms: 1s / 5s / 15s / 30s / 1m / 2m / 5m / 10m /
 * 30m. Log-ish spacing, because session length is heavy-tailed and linear bins put ~everything in
 * bin 0. Ten bins including the open-ended tail. */
const DURATION_EDGES = [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];

/** Upper edges for the pages-per-session histogram. The first bin is the 0-pageview session (custom
 * events only), then one bin each for 1..5, then 6-10, 11-20, 21+. */
const PAGE_EDGES = [1, 2, 3, 4, 5, 6, 11, 21];

/** `[from, to)` pairs for a set of upper edges, with an implicit first bin below `edges[0]` and an
 * open-ended last bin. The bins partition the whole real line, so their counts always sum to n. */
function bucketRanges(edges: number[]): { from: number; to: number | null }[] {
	const ranges: { from: number; to: number | null }[] = [{ from: 0, to: edges[0] ?? null }];
	for (let i = 1; i < edges.length; i++) {
		ranges.push({ from: edges[i - 1] as number, to: edges[i] as number });
	}
	ranges.push({ from: edges[edges.length - 1] as number, to: null });
	return ranges;
}

/** `SUM(CASE WHEN <value in bin i> THEN 1 ELSE 0 END)`. The first bin is bounded above only and the
 * last below only, so nothing outside the edges can fall through the partition. */
function bucketCountSql(value: SQL | SQLiteColumn, edges: number[], i: number): SQL<number> {
	const lo = edges[i - 1];
	const hi = edges[i];
	const predicate =
		i === 0
			? sql`${value} < ${hi}`
			: i === edges.length
				? sql`${value} >= ${lo}`
				: sql`${value} >= ${lo} AND ${value} < ${hi}`;
	return sql<number>`SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END)`;
}

/**
 * Which of the caller's filters this endpoint cannot honour, in the order they appear in the query
 * schema. `event_sessions` is a materialized per-session row carrying only channel/entry/exit;
 * hostname, path, referrer, country and device exist solely on the raw `events` rows a session was
 * folded from. Answering them would need a correlated `EXISTS` back into `events` per session, for
 * which no index exists — and answering them by IGNORING them would hand back the unfiltered
 * distribution under a filtered label, which is the failure mode a distribution endpoint must not
 * have. So the route rejects them instead.
 */
export function unsupportedDistributionFilters(f: StatsFilter): string[] {
	const unsupported: string[] = [];
	if (f.hostname !== undefined) unsupported.push('hostname');
	if (f.path !== undefined) unsupported.push('path');
	if (f.referrer !== undefined) unsupported.push('referrer');
	if (f.country !== undefined) unsupported.push('country');
	if (f.device !== undefined) unsupported.push('device');
	return unsupported;
}

/** Site + range over `event_sessions`, plus the one dimension filter the session row can answer. */
function distributionWhere(f: StatsFilter): SQL {
	const conditions: SQL[] = [buildSessionWhere(f)];
	if (f.channel !== undefined) {
		conditions.push(eq(schema.eventSessions.channel, f.channel));
	}
	return and(...conditions) as SQL;
}

/** Shape the flat SQL row for one metric into its `MetricDistribution`. */
function toDistribution(
	row: Record<string, unknown>,
	prefix: string,
	edges: number[],
): MetricDistribution {
	const num = (key: string) => Number(row[key] ?? 0);
	const percentiles = Object.fromEntries(
		PERCENTILES.map(([name]) => [name, num(`${prefix}_${name}`)]),
	) as Record<DistributionPercentile, number>;
	const histogram: DistributionBucket[] = bucketRanges(edges).map((range, i) => ({
		...range,
		count: num(`${prefix}_b${i}`),
	}));
	return {
		min: num(`${prefix}_min`),
		max: num(`${prefix}_max`),
		mean: num(`${prefix}_mean`),
		percentiles,
		histogram,
	};
}

/**
 * Distribution of session duration and pages-per-session over the range.
 *
 * ONE scan. A subquery ranks every matching session by each metric with `ROW_NUMBER()` and carries
 * the window-wide `COUNT(*)`; the outer aggregate then picks the value sitting at each percentile's
 * rank and counts the histogram bins in the same pass. That keeps every per-session value inside
 * SQLite — no row ever crosses into JS, which is both the performance property and the privacy one.
 *
 * INDEX: the range predicate is served by `idx_sessions_site_started (site_id, started_at)`. The
 * ranking still needs a sort of the matched rows over `duration_ms` / `pageviews`, which that index
 * does not cover; see the note on `sessionDistribution` in the docs for the covering index that
 * would remove it.
 */
export async function sessionDistribution(
	env: Env,
	f: StatsFilter,
): Promise<SessionDistributionResponse> {
	const where = distributionWhere(f);
	const duration = schema.eventSessions.durationMs;
	const pages = schema.eventSessions.pageviews;

	const ranked = db(env)
		.select({
			d: duration,
			p: pages,
			// One ROW_NUMBER per metric: each window has its own ORDER BY, so a single pass over the
			// filtered set yields both orderings. Ties get arbitrary distinct ranks, which is harmless
			// because tied rows carry the same value.
			rd: sql<number>`ROW_NUMBER() OVER (ORDER BY ${duration})`.as('rd'),
			rp: sql<number>`ROW_NUMBER() OVER (ORDER BY ${pages})`.as('rp'),
			n: sql<number>`COUNT(*) OVER ()`.as('n'),
		})
		.from(schema.eventSessions)
		.where(where)
		.as('ranked');

	// Subquery fields declared with `.as()` come back as `SQL.Aliased`; re-wrapping them in `sql`
	// yields the plain alias reference the outer query needs.
	const n = sql<number>`${ranked.n}`;
	const rankByDuration = sql<number>`${ranked.rd}`;
	const rankByPages = sql<number>`${ranked.rp}`;

	// `CAST(x AS INTEGER)` truncates toward zero and the operand is non-negative, so this is
	// `floor(p * (n - 1))` — the 0-based index of the nearest-rank-lower order statistic. `+ 1`
	// converts it to ROW_NUMBER's 1-based rank.
	const at = (rank: SQL, value: SQLiteColumn, p: number): SQL<number> =>
		sql<number>`MAX(CASE WHEN ${rank} = 1 + CAST(${p} * (${n} - 1) AS INTEGER) THEN ${value} END)`;

	const fields: Record<string, SQL<number>> = {
		n,
		d_min: sql<number>`MIN(${ranked.d})`,
		d_max: sql<number>`MAX(${ranked.d})`,
		d_mean: sql<number>`AVG(${ranked.d})`,
		p_min: sql<number>`MIN(${ranked.p})`,
		p_max: sql<number>`MAX(${ranked.p})`,
		p_mean: sql<number>`AVG(${ranked.p})`,
	};
	for (const [name, p] of PERCENTILES) {
		fields[`d_${name}`] = at(rankByDuration, ranked.d, p);
		fields[`p_${name}`] = at(rankByPages, ranked.p, p);
	}
	for (let i = 0; i <= DURATION_EDGES.length; i++) {
		fields[`d_b${i}`] = bucketCountSql(ranked.d, DURATION_EDGES, i);
	}
	for (let i = 0; i <= PAGE_EDGES.length; i++) {
		fields[`p_b${i}`] = bucketCountSql(ranked.p, PAGE_EDGES, i);
	}

	const [row, meta] = await Promise.all([
		// GROUP BY the window-wide count: it is constant across the subquery, so this collapses the
		// whole set to one row while keeping `n` addressable inside the percentile expressions.
		db(env)
			.select(fields)
			.from(ranked)
			.groupBy(n)
			.get(),
		sessionFreshness(env, f),
	]);

	const count = Number(row?.n ?? 0);
	const suppressed = !row || count < K_ANON_DISTRIBUTION;
	return {
		count,
		suppressed,
		min_count: K_ANON_DISTRIBUTION,
		percentile_method: 'nearest-rank-lower',
		duration_ms: suppressed || !row ? null : toDistribution(row, 'd', DURATION_EDGES),
		pageviews: suppressed || !row ? null : toDistribution(row, 'p', PAGE_EDGES),
		meta,
	};
}

// ── 2. Per-dimension time series ──────────────────────────────────────────────────────────────────

/** Default number of lines when the caller does not ask for one. Five is what a legend reads well. */
export const SERIES_DEFAULT_KEYS = 5;

const SERIES_COLUMNS: Record<SeriesDimension, SQLiteColumn> = {
	path: schema.events.path,
	referrer: schema.events.referrer,
	country: schema.events.country,
	device: schema.events.device,
	channel: schema.events.channel,
};

/**
 * A line per top-N dimension value over the range.
 *
 * The cube already answers this client-side for device/country/channel; the gap it exists to close
 * is `path` and `referrer`, which are excluded from the cube by design (high cardinality). All five
 * dimensions are accepted anyway so one endpoint serves every multi-line chart.
 *
 * Two queries: rank the keys over the whole range, then group `(bucket, key)` for just those keys.
 * Ranking is by PAGEVIEWS, which is not identical to the `top_paths` ordering on `GET /api/stats`
 * (that counts every event on a path, pageview or not) — stated here because a chart sitting beside
 * that list will otherwise look inconsistent. For `channel` this reads `events.channel`, the
 * event-level classification, not the session-level `channels` breakdown.
 *
 * PRIVACY: a key must clear the `K_ANON` floor over the whole range before it becomes a labelled
 * line, so a single-observation URL can never be plotted. Beyond that the endpoint adds no
 * resolution that `GET /api/stats?path=…&interval=hour` does not already give one call at a time;
 * it batches those calls, it does not sharpen them.
 *
 * INDEX: `idx_events_site_created_name (site_id, created_at, name)` serves the range scan and the
 * pageview/event split from the index, but the grouping column is fetched from the row for
 * `path` / `referrer` / `country` / `device` / `channel` — no index covers those. Same access shape
 * as the existing `topPaths`.
 */
export async function dimensionSeries(
	env: Env,
	f: StatsFilter,
	dimension: SeriesDimension,
	interval: Interval,
	limit: number = SERIES_DEFAULT_KEYS,
): Promise<DimensionSeriesResponse> {
	const bounded = Math.max(1, Math.min(SERIES_MAX_KEYS, Math.trunc(limit)));
	const column = SERIES_COLUMNS[dimension];
	const where = buildFilteredEventWhere(f);
	// `referrer` is stored as '' for a direct hit and country/device/channel are nullable; neither is
	// a plottable line, so both are excluded rather than rendered as a blank-labelled series.
	const defined = and(where, isNotNull(column), ne(column, '')) as SQL;

	// Rank over the whole range first — the top-N by bucket would be a different (and wrong) answer.
	// One extra row is read so `truncated` reports whether a tail existed without a second COUNT.
	const ranked = await db(env)
		.select({ key: column, total: pageviewCount })
		.from(schema.events)
		.where(defined)
		.groupBy(column)
		.having(sql`COUNT(*) >= ${K_ANON}`)
		.orderBy(desc(pageviewCount), column)
		.limit(bounded + 1);

	const keys = ranked.slice(0, bounded).map((r) => String(r.key));
	if (keys.length === 0) {
		return { dimension, interval, series: [], truncated: ranked.length > bounded };
	}

	const bucketMs = interval === 'hour' ? HOUR_MS : DAY_MS;
	const bucket = sql<number>`(${schema.events.createdAt} - (${schema.events.createdAt} % ${bucketMs}))`;
	const rows = await db(env)
		.select({ t: bucket, key: column, pageviews: pageviewCount, events: eventCount })
		.from(schema.events)
		.where(and(defined, inArray(column, keys)))
		.groupBy(bucket, column);

	const byKey = new Map<string, Map<number, DimensionSeriesPoint>>(
		keys.map((k) => [k, new Map()]),
	);
	for (const r of rows) {
		const t = Number(r.t);
		byKey.get(String(r.key))?.set(t, {
			t,
			pageviews: Number(r.pageviews ?? 0),
			events: Number(r.events ?? 0),
		});
	}

	// Zero-fill on the same bucket grid as `series()`, so every line shares the chart's x-axis.
	const series: DimensionSeries[] = keys.map((key, i) => {
		const points: DimensionSeriesPoint[] = [];
		const hits = byKey.get(key);
		for (let b = f.start - (f.start % bucketMs); b < f.end; b += bucketMs) {
			points.push(hits?.get(b) ?? { t: b, pageviews: 0, events: 0 });
		}
		return { key, total: Number(ranked[i]?.total ?? 0), points };
	});

	return { dimension, interval, series, truncated: ranked.length > bounded };
}

// ── 3. Path hierarchy ─────────────────────────────────────────────────────────────────────────────

/** Depth the tree stops at. `/a/b/c/d/e` contributes to `/a/b/c/d`. Four levels is what a treemap
 * or a sunburst can render legibly, and it bounds the node count with `PATH_TREE_MAX_CHILDREN`. */
export const PATH_TREE_MAX_DEPTH = 4;

/** Labelled children kept per node; the rest fold into one synthetic `other` sibling. */
export const PATH_TREE_MAX_CHILDREN = 12;

/** Distinct paths read before the long tail is dropped. Bounds the JS-side roll-up input; a site
 * with more distinct URLs than this gets `truncated: true` rather than an unbounded read. */
export const PATH_TREE_MAX_PATHS = 2000;

/** A node under construction: the finished shape plus the child index the roll-up needs. */
interface TreeBuilder {
	path: string;
	segment: string;
	depth: number;
	pageviews: number;
	self: number;
	children: Map<string, TreeBuilder>;
}

function newNode(path: string, segment: string, depth: number): TreeBuilder {
	return { path, segment, depth, pageviews: 0, self: 0, children: new Map() };
}

/** Split a path into at most `PATH_TREE_MAX_DEPTH` segments, dropping any query/fragment and empty
 * segments so `/blog//post/` and `/blog/post` land on the same node. Truncating here is what
 * implements the depth cap: a deeper URL's pageviews land on its ancestor at the cap. */
function segmentsOf(path: string): string[] {
	const clean = path.split(/[?#]/)[0] ?? '';
	return clean
		.split('/')
		.filter((segment) => segment.length > 0)
		.slice(0, PATH_TREE_MAX_DEPTH);
}

/**
 * The URL-prefix tree for the range: `/blog/post-a` and `/blog/post-b` roll up under `/blog`.
 *
 * Counts PAGEVIEWS (beacons with no event name), so the root total reconciles with
 * `summary.pageviews` on `GET /api/stats`. It deliberately does not match `top_paths`, which counts
 * every event on a path.
 *
 * The grouping is SQL; only the prefix roll-up is JS, over at most `PATH_TREE_MAX_PATHS` already
 * aggregated rows. Doing the roll-up in SQLite would mean a per-level `instr`/`substr` pass with no
 * index to help it, for a set this small.
 *
 * PRIVACY: a URL path is attacker-controlled text that can carry an identifier a site accidentally
 * put in its own routes. Any subtree below `K_ANON` pageviews is folded into its parent's synthetic
 * `other` node rather than being labelled — strictly stronger than `top_paths`, which surfaces a
 * one-hit path verbatim. Folding preserves the totals, so nothing is silently lost from the chart.
 */
export async function pathTree(env: Env, f: StatsFilter): Promise<PathTreeResponse> {
	const rows = await db(env)
		.select({ path: schema.events.path, pageviews: pageviewCount })
		.from(schema.events)
		.where(buildFilteredEventWhere(f))
		.groupBy(schema.events.path)
		.having(sql`${pageviewCount} > 0`)
		.orderBy(desc(pageviewCount), schema.events.path)
		.limit(PATH_TREE_MAX_PATHS + 1);

	const kept = rows.slice(0, PATH_TREE_MAX_PATHS);
	const root = newNode('/', '', 0);

	for (const row of kept) {
		const pageviews = Number(row.pageviews ?? 0);
		const segments = segmentsOf(String(row.path));
		root.pageviews += pageviews;
		let node = root;
		for (const segment of segments) {
			const path = node.path === '/' ? `/${segment}` : `${node.path}/${segment}`;
			let child = node.children.get(segment);
			if (!child) {
				child = newNode(path, segment, node.depth + 1);
				node.children.set(segment, child);
			}
			child.pageviews += pageviews;
			node = child;
		}
		// Whatever level the walk stopped at owns the pageviews: the exact page for a shallow path,
		// or the depth-cap ancestor for a deeper one.
		node.self += pageviews;
	}

	return {
		max_depth: PATH_TREE_MAX_DEPTH,
		min_count: K_ANON,
		root: finalize(root),
		paths: kept.length,
		truncated: rows.length > PATH_TREE_MAX_PATHS,
	};
}

/** Fold each node's below-floor and long-tail children into one `other` sibling, then emit the
 * immutable `PathTreeNode`. Children are ordered by pageviews descending, `other` always last. */
function finalize(node: TreeBuilder): PathTreeNode {
	const all = [...node.children.values()].sort(
		(a, b) => b.pageviews - a.pageviews || a.segment.localeCompare(b.segment),
	);
	const labelled = all.filter((c) => c.pageviews >= K_ANON).slice(0, PATH_TREE_MAX_CHILDREN);
	const folded = all.filter((c) => !labelled.includes(c));
	const children = labelled.map(finalize);
	if (folded.length > 0) {
		const pageviews = folded.reduce((sum, c) => sum + c.pageviews, 0);
		children.push({
			path: node.path === '/' ? '/…' : `${node.path}/…`,
			segment: '…',
			depth: node.depth + 1,
			pageviews,
			self: pageviews,
			children: [],
			other: true,
		});
	}
	return {
		path: node.path,
		segment: node.segment,
		depth: node.depth,
		pageviews: node.pageviews,
		self: node.self,
		children,
	};
}

// ── 4. Entry → exit journeys ──────────────────────────────────────────────────────────────────────

/** Top pairs returned. A chord diagram or a Sankey stops being readable well before this. */
export const JOURNEY_MAX_PAIRS = 50;

/**
 * The most-travelled entry→exit journeys over the range, from the materialized session rows.
 *
 * PRIVACY: this is the most re-identifying shape in the file — a two-step behavioural sequence over
 * two attacker-supplied URLs. The floor is therefore on DISTINCT VISITORS, not sessions: one person
 * reloading a rare page three times must not clear it, and only `COUNT(DISTINCT visitor_hash)` says
 * so. The reported `sessions` is still the session count, because that is what the ribbon width
 * means. `total_sessions` is reported alongside so the UI can show how much the floor withheld
 * rather than implying the pairs are exhaustive.
 *
 * INDEX: `idx_sessions_site_started (site_id, started_at)` serves the range scan; the grouping over
 * `(entry_path, exit_path)` is a sort/hash over the matched rows, uncovered by any index.
 */
export async function journeys(env: Env, f: StatsFilter): Promise<JourneysResponse> {
	const where = buildSessionWhere(f);
	const sessions = sql<number>`COUNT(*)`;
	const [rows, totals, meta] = await Promise.all([
		db(env)
			.select({
				entry: schema.eventSessions.entryPath,
				exit: schema.eventSessions.exitPath,
				sessions,
			})
			.from(schema.eventSessions)
			.where(where)
			.groupBy(schema.eventSessions.entryPath, schema.eventSessions.exitPath)
			.having(sql`COUNT(DISTINCT ${schema.eventSessions.visitorHash}) >= ${K_ANON}`)
			.orderBy(desc(sessions), schema.eventSessions.entryPath, schema.eventSessions.exitPath)
			.limit(JOURNEY_MAX_PAIRS),
		db(env).select({ n: sql<number>`COUNT(*)` }).from(schema.eventSessions).where(where).get(),
		sessionFreshness(env, f),
	]);

	const pairs: JourneyPair[] = rows.map((r) => ({
		entry: String(r.entry),
		exit: String(r.exit),
		sessions: Number(r.sessions),
	}));
	return {
		pairs,
		min_visitors: K_ANON,
		sessions: pairs.reduce((sum, p) => sum + p.sessions, 0),
		total_sessions: Number(totals?.n ?? 0),
		meta,
	};
}

// ── 5. Hour-of-day / day-of-week ──────────────────────────────────────────────────────────────────

const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;

/**
 * Activity folded onto the 7 × 24 UTC grid.
 *
 * TIMEZONE: pure integer arithmetic on the epoch — `created_at / 3_600_000 % 24` is the UTC hour by
 * construction, and `(created_at / 86_400_000 + 4) % 7` the UTC weekday (1970-01-01 was a Thursday,
 * index 4 with Sunday = 0). No `strftime`, no site timezone, no server locale: the codebase treats
 * timestamps as UTC and this endpoint will not quietly become the one place that does not.
 *
 * PRIVACY: strictly coarser than what `GET /api/stats?interval=hour` already returns — it collapses
 * every date in the range onto one weekly grid, so it can only blur timestamps, never sharpen them.
 * No floor is applied, for the same reason the hourly series has none.
 *
 * INDEX: `idx_events_site_created_name (site_id, created_at, name)` holds every column this query
 * touches, so with no extra dimension filter it is answered from the index without touching the
 * table. Output is a fixed 168 cells whatever the range.
 */
export async function clock(env: Env, f: StatsFilter): Promise<ClockResponse> {
	const createdAt = schema.events.createdAt;
	const hour = sql<number>`(${createdAt} / 3600000) % 24`;
	const day = sql<number>`((${createdAt} / 86400000) + 4) % 7`;
	const rows = await db(env)
		.select({ day, hour, pageviews: pageviewCount, events: eventCount })
		.from(schema.events)
		.where(buildFilteredEventWhere(f))
		.groupBy(day, hour);

	const cells: ClockCell[] = [];
	const index = new Map<number, { pageviews: number; events: number }>();
	for (const r of rows) {
		index.set(Number(r.day) * HOURS_PER_DAY + Number(r.hour), {
			pageviews: Number(r.pageviews ?? 0),
			events: Number(r.events ?? 0),
		});
	}
	const byHour = new Array<number>(HOURS_PER_DAY).fill(0);
	const byDay = new Array<number>(DAYS_PER_WEEK).fill(0);
	for (let d = 0; d < DAYS_PER_WEEK; d++) {
		for (let h = 0; h < HOURS_PER_DAY; h++) {
			const hit = index.get(d * HOURS_PER_DAY + h) ?? { pageviews: 0, events: 0 };
			cells.push({ day: d, hour: h, pageviews: hit.pageviews, events: hit.events });
			byHour[h] = (byHour[h] as number) + hit.pageviews;
			byDay[d] = (byDay[d] as number) + hit.pageviews;
		}
	}
	return { timezone: 'UTC', cells, by_hour: byHour, by_day: byDay };
}
