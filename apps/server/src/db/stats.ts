// Stats aggregation over the indexed `events` table. Every helper composes `buildEventWhere` and
// reads via Drizzle `sql` helpers (COUNT(DISTINCT …), bucket math) — no raw string SQL. Time is
// unix ms; ranges are [start, end).

import type {
	AttributionResult,
	CohortPeriod,
	CohortRetentionResponse,
	CohortRow,
	CountRow,
	CubeCell,
	CubeResponse,
	EngagementSummary,
	Freshness,
	Interval,
	RealtimeContextResponse,
	RealtimeSnapshot,
	RevenueSummary,
	SeriesPoint,
	StatsAcquisitionResponse,
	StatsAttributionResponse,
	StatsContentResponse,
	StatsCoreResponse,
	StatsEngagementResponse,
	StatsFilter,
	StatsFreshnessResponse,
	StatsRevenueResponse,
	StatsSummary,
	StatsSummaryResponse,
	StatsTechnologyResponse,
} from '@facet/shared';
import { type SQL, and, desc, eq, gte, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Env } from '../env.js';
import { computeAttribution } from '../lib/attribution.js';
import { DAY_MS, HOUR_MS, SESSION_TIMEOUT_MS } from '../lib/constants.js';
import { buildEventWhere } from './filters.js';
import { db } from './queries.js';
import * as schema from './schema.js';

// Internal/system events (experiment `$exposure`, any `$`-prefixed name, and the auto-generated
// `form_submit` interaction) are excluded from marketer-facing "custom event" metrics. They remain
// in the raw `events` table for experiments/conversions/diagnostics and are surfaced separately via
// `topInteractions`. Keep this predicate and its complement in sync.
const isCustomEvent = sql`${schema.events.name} IS NOT NULL AND ${schema.events.name} NOT LIKE '$%' AND ${schema.events.name} <> 'form_submit'`;
const isInteraction = sql`${schema.events.name} IS NOT NULL AND (${schema.events.name} LIKE '$%' OR ${schema.events.name} = 'form_submit')`;

/** Compose the base site/hostname/range predicate with the optional exact-match dimension filters
 * (path/referrer/country/device/channel). Each, when defined, appends `AND <col> = value`, so
 * summary/series/breakdown reads all narrow to the same filtered rows. Country/device/channel may be
 * NULL in `events`; an exact-match on a provided value simply won't match those, which is correct.
 * The cube narrows this scope to the dimensions it can apply without collapsing its open axes. */
export function buildFilteredEventWhere(f: StatsFilter): SQL {
	const conditions: SQL[] = [buildEventWhere(f)];
	if (f.path !== undefined) {
		conditions.push(eq(schema.events.path, f.path));
	}
	if (f.referrer !== undefined) {
		conditions.push(eq(schema.events.referrer, f.referrer));
	}
	if (f.country !== undefined) {
		conditions.push(eq(schema.events.country, f.country));
	}
	if (f.device !== undefined) {
		conditions.push(eq(schema.events.device, f.device));
	}
	if (f.channel !== undefined) {
		conditions.push(eq(schema.events.channel, f.channel));
	}
	return and(...conditions) as SQL;
}

export const pageviewCount = sql<number>`SUM(CASE WHEN ${schema.events.name} IS NULL THEN 1 ELSE 0 END)`;
export const eventCount = sql<number>`SUM(CASE WHEN ${isCustomEvent} THEN 1 ELSE 0 END)`;
const visitorCount = sql<number>`COUNT(DISTINCT ${schema.events.visitorHash})`;

interface BatchQuery {
	toSQL(): { sql: string; params: unknown[] };
}

/** Privacy-safe D1 cost and latency metadata for one named stats slice. */
export interface StatsReadMetrics {
	durationMs: number;
	d1DurationMs: number;
	rowsRead: number;
	statements: number;
}

export interface StatsRead<T> {
	data: T;
	metrics: StatsReadMetrics;
}

/** Execute independent analytical statements in one D1 batch and retain the per-query metadata that
 * Drizzle's row mapping normally discards. Query text, parameters, site ids, and dimensions are never
 * included in the returned telemetry. */
async function statsBatch(
	env: Env,
	queries: readonly BatchQuery[],
): Promise<{ rows: Record<string, unknown>[][]; metrics: StatsReadMetrics }> {
	const statements = queries.map((query) => {
		const built = query.toSQL();
		return env.DB.prepare(built.sql).bind(...built.params);
	});
	const started = performance.now();
	const results = await env.DB.batch<Record<string, unknown>>(statements);
	return {
		rows: results.map((result) => result.results),
		metrics: {
			durationMs: performance.now() - started,
			d1DurationMs: results.reduce((total, result) => total + result.meta.duration, 0),
			rowsRead: results.reduce((total, result) => total + result.meta.rows_read, 0),
			statements: statements.length,
		},
	};
}

function summaryQuery(env: Env, f: StatsFilter) {
	return db(env)
		.select({
			pageviews: pageviewCount.as('pageviews'),
			events: eventCount.as('events'),
			visitors: visitorCount.as('visitors'),
		})
		.from(schema.events)
		.where(buildFilteredEventWhere(f));
}

function mapSummary(row?: Record<string, unknown>): StatsSummary {
	return {
		pageviews: Number(row?.pageviews ?? 0),
		events: Number(row?.events ?? 0),
		visitors: Number(row?.visitors ?? 0),
	};
}

/** Pageviews (name IS NULL), custom events (name IS NOT NULL), and distinct visitors. */
export async function summary(env: Env, f: StatsFilter): Promise<StatsSummary> {
	return mapSummary(await summaryQuery(env, f).get());
}

function seriesQuery(env: Env, f: StatsFilter, interval: Interval) {
	const bucketMs = interval === 'hour' ? HOUR_MS : DAY_MS;
	const bucket = sql<number>`(${schema.events.createdAt} - (${schema.events.createdAt} % ${bucketMs}))`;
	return db(env)
		.select({
			t: bucket.as('t'),
			pageviews: pageviewCount.as('pageviews'),
			visitors: visitorCount.as('visitors'),
		})
		.from(schema.events)
		.where(buildFilteredEventWhere(f))
		.groupBy(bucket)
		.orderBy(bucket);
}

function mapSeries(
	rows: Record<string, unknown>[],
	f: StatsFilter,
	interval: Interval,
): SeriesPoint[] {
	const bucketMs = interval === 'hour' ? HOUR_MS : DAY_MS;
	const byBucket = new Map<number, { pageviews: number; visitors: number }>();
	for (const row of rows) {
		byBucket.set(Number(row.t), {
			pageviews: Number(row.pageviews ?? 0),
			visitors: Number(row.visitors ?? 0),
		});
	}
	const points: SeriesPoint[] = [];
	for (let bucket = f.start - (f.start % bucketMs); bucket < f.end; bucket += bucketMs) {
		const hit = byBucket.get(bucket);
		points.push({
			t: bucket,
			pageviews: hit?.pageviews ?? 0,
			visitors: hit?.visitors ?? 0,
		});
	}
	return points;
}

/** Time series bucketed by hour/day, ascending, with every empty bucket in [start, end) zero-filled. */
export async function series(env: Env, f: StatsFilter, interval: Interval): Promise<SeriesPoint[]> {
	return mapSeries(await seriesQuery(env, f, interval), f, interval);
}

/** Summary + series in one D1 round-trip for callers that render only totals and traffic. */
export async function coreStats(
	env: Env,
	f: StatsFilter,
	interval: Interval,
): Promise<StatsRead<StatsCoreResponse>> {
	const { rows, metrics } = await statsBatch(env, [
		summaryQuery(env, f),
		seriesQuery(env, f, interval),
	]);
	return {
		data: {
			summary: mapSummary(rows[0]?.[0]),
			series: mapSeries(rows[1] ?? [], f, interval),
		},
		metrics,
	};
}

/** Totals-only read with D1 rows-read metadata. */
export async function summaryStats(
	env: Env,
	f: StatsFilter,
): Promise<StatsRead<StatsSummaryResponse>> {
	const { rows, metrics } = await statsBatch(env, [summaryQuery(env, f)]);
	return { data: { summary: mapSummary(rows[0]?.[0]) }, metrics };
}

/** How many countries the cube keeps distinct before folding the long tail into `'other'`. */
const CUBE_TOP_COUNTRIES = 30;

/** Keep the low-cardinality axes open for client slicing while applying the server-only path/referrer
 * scope. A path drill therefore gets a cube for that path, not an unfiltered cube under a filtered UI. */
function cubeScope(f: StatsFilter): StatsFilter {
	return {
		siteId: f.siteId,
		hostname: f.hostname,
		start: f.start,
		end: f.end,
		path: f.path,
		referrer: f.referrer,
	};
}

function cubeQuery(env: Env, f: StatsFilter, interval: Interval, topCountries: readonly string[]) {
	const bucketMs = interval === 'hour' ? HOUR_MS : DAY_MS;
	const bucket = sql<number>`(${schema.events.createdAt} - (${schema.events.createdAt} % ${bucketMs}))`;
	const country =
		topCountries.length > 0
			? sql<string>`CASE WHEN ${schema.events.country} IN (${sql.join(
					topCountries.map((c) => sql`${c}`),
					sql`, `,
				)}) THEN ${schema.events.country} ELSE 'other' END`
			: sql<string>`COALESCE(${schema.events.country}, 'other')`;
	const device = sql<string>`COALESCE(${schema.events.device}, 'unknown')`;
	const channel = sql<string>`COALESCE(${schema.events.channel}, 'unknown')`;

	return db(env)
		.select({
			t: bucket.as('t'),
			device: device.as('device'),
			country: country.as('country'),
			channel: channel.as('channel'),
			pageviews: pageviewCount.as('pageviews'),
			events: eventCount.as('events'),
			visitors: visitorCount.as('visitors'),
		})
		.from(schema.events)
		.where(buildFilteredEventWhere(cubeScope(f)))
		.groupBy(bucket, device, country, channel);
}

function mapCube(rows: readonly Record<string, unknown>[]): CubeCell[] {
	return rows.map((row) => ({
		t: Number(row.t),
		device: String(row.device),
		country: String(row.country),
		channel: String(row.channel),
		pageviews: Number(row.pageviews ?? 0),
		events: Number(row.events ?? 0),
		visitors: Number(row.visitors ?? 0),
	}));
}

/** A small dimensional cube for instant client-side slicing. Its two dependent statements retain D1
 * metadata even though the second query needs the first query's bounded country key set. */
export async function cubeStats(
	env: Env,
	f: StatsFilter,
	interval: Interval,
): Promise<StatsRead<CubeResponse>> {
	const started = performance.now();
	const scope = cubeScope(f);
	const countriesRead = await statsBatch(env, [
		topByColumnQuery(env, scope, schema.events.country, {
			excludeNull: true,
			limit: CUBE_TOP_COUNTRIES,
		}),
	]);
	const topCountries = mapCountRows(countriesRead.rows[0] ?? []).map((row) => row.key);
	const cubeRead = await statsBatch(env, [cubeQuery(env, scope, interval, topCountries)]);
	return {
		data: { interval, cells: mapCube(cubeRead.rows[0] ?? []) },
		metrics: {
			durationMs: performance.now() - started,
			d1DurationMs: countriesRead.metrics.d1DurationMs + cubeRead.metrics.d1DurationMs,
			rowsRead: countriesRead.metrics.rowsRead + cubeRead.metrics.rowsRead,
			statements: countriesRead.metrics.statements + cubeRead.metrics.statements,
		},
	};
}

export async function cube(env: Env, f: StatsFilter, interval: Interval): Promise<CubeCell[]> {
	return (await cubeStats(env, f, interval)).data.cells;
}

/** Shared top-N query over one column, sorted by count desc (key asc for stable ties). */
function topByColumnQuery(
	env: Env,
	f: StatsFilter,
	column: SQLiteColumn,
	opts: {
		excludeNull?: boolean;
		excludeEmpty?: boolean;
		limit?: number;
		extra?: SQL;
		/** k-anonymity floor: only surface a value whose cohort has at least this many events, so a
		 * segment can never resolve to a near-unique visitor (the privacy guarantee Umami lacks). */
		minCount?: number;
	} = {},
) {
	const conditions: SQL[] = [buildFilteredEventWhere(f)];
	if (opts.excludeNull) {
		conditions.push(isNotNull(column));
	}
	if (opts.excludeEmpty) {
		conditions.push(ne(column, ''));
	}
	if (opts.extra) {
		conditions.push(opts.extra);
	}
	const count = sql<number>`COUNT(*)`;
	const grouped = db(env)
		.select({ key: sql`${column}`.as('key'), count: count.as('count') })
		.from(schema.events)
		.where(and(...conditions))
		.groupBy(column);
	const bounded = opts.minCount ? grouped.having(sql`COUNT(*) >= ${opts.minCount}`) : grouped;
	return bounded.orderBy(desc(count), column).limit(opts.limit ?? 1000);
}

function mapCountRows(rows: readonly unknown[]): CountRow[] {
	const mapped: CountRow[] = [];
	for (const row of rows) {
		if (typeof row !== 'object' || row === null || !('key' in row) || !('count' in row)) {
			continue;
		}
		mapped.push({ key: String(row.key), count: Number(row.count) });
	}
	return mapped;
}

/** Shared top-N count over one column. */
async function topByColumn(
	env: Env,
	f: StatsFilter,
	column: SQLiteColumn,
	opts: {
		excludeNull?: boolean;
		excludeEmpty?: boolean;
		limit?: number;
		extra?: SQL;
		minCount?: number;
	} = {},
): Promise<CountRow[]> {
	return mapCountRows(await topByColumnQuery(env, f, column, opts));
}

/** Paths + marketer-facing custom events in one D1 round-trip for the default Overview. */
export async function contentStats(
	env: Env,
	f: StatsFilter,
): Promise<StatsRead<StatsContentResponse>> {
	const { rows, metrics } = await statsBatch(env, [
		topByColumnQuery(env, f, schema.events.path, { limit: 10 }),
		topByColumnQuery(env, f, schema.events.name, {
			excludeNull: true,
			limit: 10,
			extra: isCustomEvent,
		}),
	]);
	return {
		data: {
			top_paths: mapCountRows(rows[0] ?? []),
			top_events: mapCountRows(rows[1] ?? []),
		},
		metrics,
	};
}

/** Referrer ranking for the optional acquisition tile. */
export async function acquisitionStats(
	env: Env,
	f: StatsFilter,
): Promise<StatsRead<StatsAcquisitionResponse>> {
	const { rows, metrics } = await statsBatch(env, [
		topByColumnQuery(env, f, schema.events.referrer, {
			excludeEmpty: true,
			limit: 10,
		}),
	]);
	return { data: { top_referrers: mapCountRows(rows[0] ?? []) }, metrics };
}

/** k-anonymity threshold for the segmentation dimensions: a value is only surfaced once at least this
 * many events share it, so no breakdown (or cross-filter intersection) can single out a visitor. */
export const K_ANON = 3;

export function topBrowsers(env: Env, f: StatsFilter, limit = 12): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.browser, {
		excludeNull: true,
		limit,
		minCount: K_ANON,
	});
}

export function topOperatingSystems(env: Env, f: StatsFilter, limit = 12): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.os, {
		excludeNull: true,
		limit,
		minCount: K_ANON,
	});
}

export function topScreens(env: Env, f: StatsFilter, limit = 8): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.screenTier, {
		excludeNull: true,
		limit,
		minCount: K_ANON,
	});
}

export function topLanguages(env: Env, f: StatsFilter, limit = 12): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.language, {
		excludeNull: true,
		limit,
		minCount: K_ANON,
	});
}

export function topRegions(env: Env, f: StatsFilter, limit = 12): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.region, {
		excludeNull: true,
		limit,
		minCount: K_ANON,
	});
}

export function topNetworks(env: Env, f: StatsFilter, limit = 12): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.network, {
		excludeNull: true,
		limit,
		minCount: K_ANON,
	});
}

export function topConnections(env: Env, f: StatsFilter, limit = 4): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.connection, {
		excludeNull: true,
		limit,
		minCount: K_ANON,
	});
}

/** The seven k-anonymised technology rankings, batched only for an active technology tile. */
export async function technologyStats(
	env: Env,
	f: StatsFilter,
): Promise<StatsRead<StatsTechnologyResponse>> {
	const dimensions = [
		[schema.events.browser, 12],
		[schema.events.os, 12],
		[schema.events.screenTier, 8],
		[schema.events.language, 12],
		[schema.events.region, 12],
		[schema.events.network, 12],
		[schema.events.connection, 4],
	] as const;
	const { rows, metrics } = await statsBatch(
		env,
		dimensions.map(([column, limit]) =>
			topByColumnQuery(env, f, column, { excludeNull: true, limit, minCount: K_ANON }),
		),
	);
	return {
		data: {
			top_browsers: mapCountRows(rows[0] ?? []),
			top_os: mapCountRows(rows[1] ?? []),
			top_screens: mapCountRows(rows[2] ?? []),
			top_languages: mapCountRows(rows[3] ?? []),
			top_regions: mapCountRows(rows[4] ?? []),
			top_networks: mapCountRows(rows[5] ?? []),
			top_connections: mapCountRows(rows[6] ?? []),
		},
		metrics,
	};
}

/** Ecommerce revenue over the range. Grouped by currency and reporting the dominant one, so total /
 * orders / AOV are always currency-consistent (correct for single-currency sites; the top currency for
 * mixed). `orders` counts valued events. */
function revenueQuery(env: Env, f: StatsFilter) {
	const total = sql<number>`SUM(${schema.events.value})`;
	return db(env)
		.select({
			currency: schema.events.currency,
			total: total.as('total'),
			orders: sql<number>`COUNT(${schema.events.value})`.as('orders'),
		})
		.from(schema.events)
		.where(and(buildFilteredEventWhere(f), isNotNull(schema.events.value)))
		.groupBy(schema.events.currency)
		.orderBy(desc(total));
}

function mapRevenue(rows: Record<string, unknown>[]): RevenueSummary {
	const top = rows[0];
	const totalValue = Number(top?.total ?? 0);
	const orders = Number(top?.orders ?? 0);
	return {
		total: totalValue,
		orders,
		aov: orders > 0 ? totalValue / orders : 0,
		currency: top?.currency == null ? null : String(top.currency),
	};
}

/** Ecommerce revenue over the range. */
export async function revenue(env: Env, f: StatsFilter): Promise<RevenueSummary> {
	return mapRevenue(await revenueQuery(env, f));
}

/** Revenue summed per channel, k-anonymised on order count so a channel with too few orders is not
 * surfaced. `count` carries the (rounded) revenue so it renders through the shared ranked-list boxes. */
function revenueByChannelQuery(env: Env, f: StatsFilter, limit = 12) {
	const sum = sql<number>`SUM(${schema.events.value})`;
	return db(env)
		.select({
			key: sql`${schema.events.channel}`.as('key'),
			sum: sum.as('sum'),
		})
		.from(schema.events)
		.where(
			and(
				buildFilteredEventWhere(f),
				isNotNull(schema.events.value),
				isNotNull(schema.events.channel),
			),
		)
		.groupBy(schema.events.channel)
		.having(sql`COUNT(${schema.events.value}) >= ${K_ANON}`)
		.orderBy(desc(sum))
		.limit(limit);
}

function mapRevenueByChannel(rows: Record<string, unknown>[]): CountRow[] {
	return rows.map((row) => ({
		key: String(row.key),
		count: Math.round(Number(row.sum)),
	}));
}

export async function revenueByChannel(env: Env, f: StatsFilter, limit = 12): Promise<CountRow[]> {
	return mapRevenueByChannel(await revenueByChannelQuery(env, f, limit));
}

/** Revenue totals + channel rollup without executing the attribution input scan. */
export async function revenueStats(
	env: Env,
	f: StatsFilter,
): Promise<StatsRead<StatsRevenueResponse>> {
	const { rows, metrics } = await statsBatch(env, [
		revenueQuery(env, f),
		revenueByChannelQuery(env, f),
	]);
	return {
		data: {
			revenue: mapRevenue(rows[0] ?? []),
			revenue_by_channel: mapRevenueByChannel(rows[1] ?? []),
		},
		metrics,
	};
}

/** Cap on events scanned for attribution — a heavier read, so it is bounded for very high-volume
 * ranges. Ordered by (visitor, time), NOT recency: the grouping loop needs each visitor-day's
 * touches complete and chronological to credit first/last touch correctly. A `desc(createdAt)`
 * order would look like it "keeps the newest" but would actually truncate journeys mid-day; this
 * order instead drops only whole visitor-days, all but the one straddling the cap. */
const ATTRIBUTION_MAX_EVENTS = 50000;

/** Multi-touch attribution: build each visitor's within-day channel path (identity is only stable inside
 * a UTC day — the salt rotates daily, so this needs NO persistent cross-session id), flag the day as
 * converting with its summed revenue, and run the attribution models. */
function attributionQuery(env: Env, f: StatsFilter) {
	return (
		db(env)
			.select({
				vh: sql`${schema.events.visitorHash}`.as('vh'),
				at: sql`${schema.events.createdAt}`.as('at'),
				channel: schema.events.channel,
				value: schema.events.value,
			})
			.from(schema.events)
			.where(and(buildFilteredEventWhere(f), isNotNull(schema.events.channel)))
			.orderBy(schema.events.visitorHash, schema.events.createdAt)
			// One sentinel row distinguishes an exact result from a plausible-looking truncated one.
			.limit(ATTRIBUTION_MAX_EVENTS + 1)
	);
}

function mapAttribution(rows: Record<string, unknown>[]): AttributionResult {
	const truncated = rows.length > ATTRIBUTION_MAX_EVENTS;
	const scanned = truncated ? rows.slice(0, ATTRIBUTION_MAX_EVENTS) : rows;
	// Group rows into (visitor, UTC day) paths. Rows arrive ordered by (visitor, time), so each group's
	// channels are already in touch order.
	const groups = new Map<string, { channels: string[]; value: number; converted: boolean }>();
	for (const row of scanned) {
		const day = Math.floor(Number(row.at) / DAY_MS);
		const key = `${row.vh}|${day}`;
		let g = groups.get(key);
		if (!g) {
			g = { channels: [], value: 0, converted: false };
			groups.set(key, g);
		}
		if (row.channel) g.channels.push(String(row.channel));
		const v = row.value == null ? null : Number(row.value);
		if (v != null && Number.isFinite(v) && v > 0) {
			g.value += v;
			g.converted = true;
		}
	}
	return {
		...computeAttribution([...groups.values()]),
		meta: {
			exact: !truncated,
			truncated,
			rows_scanned: scanned.length,
			range_supported: !truncated,
		},
	};
}

export async function attribution(env: Env, f: StatsFilter): Promise<AttributionResult> {
	return mapAttribution(await attributionQuery(env, f));
}

/** Revenue + attribution in one bounded D1 batch for the optional attribution surface. */
export async function attributionStats(
	env: Env,
	f: StatsFilter,
): Promise<StatsRead<StatsAttributionResponse>> {
	const { rows, metrics } = await statsBatch(env, [
		revenueQuery(env, f),
		revenueByChannelQuery(env, f),
		attributionQuery(env, f),
	]);
	return {
		data: {
			revenue: mapRevenue(rows[0] ?? []),
			revenue_by_channel: mapRevenueByChannel(rows[1] ?? []),
			attribution: mapAttribution(rows[2] ?? []),
		},
		metrics,
	};
}

export function topPaths(env: Env, f: StatsFilter, limit = 10): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.path, { limit });
}

export function topReferrers(env: Env, f: StatsFilter, limit = 10): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.referrer, {
		excludeEmpty: true,
		limit,
	});
}

/** Marketer-facing custom events only ($-prefixed internals and form_submit are excluded). */
export function topEvents(env: Env, f: StatsFilter, limit = 10): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.name, {
		excludeNull: true,
		limit,
		extra: isCustomEvent,
	});
}

/** Internal/system interactions ($exposure, other $-prefixed events, form_submit), shown separately. */
export function topInteractions(env: Env, f: StatsFilter, limit = 10): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.name, {
		excludeNull: true,
		limit,
		extra: isInteraction,
	});
}

export function topCountries(env: Env, f: StatsFilter, limit = 10): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.country, {
		excludeNull: true,
		limit,
	});
}

export function topDevices(env: Env, f: StatsFilter): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.device, { excludeNull: true });
}

/** Build the site + [start, end) predicate over `event_sessions` (hostname is not a session column). */
export function buildSessionWhere(f: StatsFilter): SQL {
	return and(
		eq(schema.eventSessions.siteId, f.siteId),
		gte(schema.eventSessions.startedAt, f.start),
		lt(schema.eventSessions.startedAt, f.end),
	) as SQL;
}

function freshnessQueries(env: Env, f: StatsFilter) {
	return [
		db(env)
			.select({ latest: sql<number | null>`MAX(${schema.events.createdAt})`.as('latest') })
			.from(schema.events)
			.where(buildEventWhere(f)),
		db(env)
			.select({
				latest: sql<number | null>`MAX(${schema.eventSessions.endedAt})`.as('latest'),
			})
			.from(schema.eventSessions)
			.where(
				and(
					eq(schema.eventSessions.siteId, f.siteId),
					gte(schema.eventSessions.startedAt, f.start - SESSION_TIMEOUT_MS),
					lt(schema.eventSessions.startedAt, f.end),
				),
			),
	] as const;
}

function mapFreshness(
	rawRow?: Record<string, unknown>,
	sessionRow?: Record<string, unknown>,
): Freshness {
	const latestEvent = rawRow?.latest == null ? null : Number(rawRow.latest);
	const latestSession = sessionRow?.latest == null ? null : Number(sessionRow.latest);
	return {
		materialization: 'hourly',
		pending: latestEvent !== null && (latestSession === null || latestEvent > latestSession),
	};
}

/**
 * Freshness signal for session-derived analytics. `pending` is true when the range holds raw events
 * the hourly cron has not sessionized yet, so a caller can distinguish "no data" from "not built yet".
 *
 * IMPORTANT: this compares materialization watermarks, not row counts. A row count only detects a
 * range with NO sessions at all, so a 7d range whose trailing hour is unsessionized reported fresh
 * while every session-derived read (engagement, channels, funnels, journeys) silently omitted that
 * hour. `ended_at` is the group's last event time, so a fully materialized range satisfies
 * max(ended_at) >= max(created_at). The session scan looks back one timeout because the session
 * covering the range's newest event may have started just before `f.start`.
 */
export async function sessionFreshness(env: Env, f: StatsFilter): Promise<Freshness> {
	const [rawQuery, sessionQuery] = freshnessQueries(env, f);
	const [rawRow, sessionRow] = await Promise.all([rawQuery.get(), sessionQuery.get()]);
	return mapFreshness(rawRow, sessionRow);
}

/** Freshness-only read in a single D1 batch, with no unrelated analytics. */
export async function freshnessStats(
	env: Env,
	f: StatsFilter,
): Promise<StatsRead<StatsFreshnessResponse>> {
	const { rows, metrics } = await statsBatch(env, freshnessQueries(env, f));
	return {
		data: { meta: mapFreshness(rows[0]?.[0], rows[1]?.[0]) },
		metrics,
	};
}

/**
 * Realtime snapshot: distinct visitor hashes and pageviews over the trailing `[now - windowMs, now)`
 * window for a site. Bounded (small window, indexed by created_at). Privacy-safe: no cookies or
 * persistent ids — just the daily visitor hash, de-duplicated within the window.
 */
export async function realtime(
	env: Env,
	siteId: string,
	now: number,
	windowMs: number,
): Promise<RealtimeSnapshot> {
	const start = now - windowMs;
	const row = await db(env)
		.select({ visitors: visitorCount, pageviews: pageviewCount })
		.from(schema.events)
		.where(
			and(
				eq(schema.events.siteId, siteId),
				gte(schema.events.createdAt, start),
				lt(schema.events.createdAt, now),
			),
		)
		.get();
	return {
		window_ms: windowMs,
		visitors: Number(row?.visitors ?? 0),
		pageviews: Number(row?.pageviews ?? 0),
		until: now,
	};
}

function engagementQuery(env: Env, f: StatsFilter) {
	return db(env)
		.select({
			sessions: sql<number>`COUNT(*)`.as('sessions'),
			bounces: sql<number>`SUM(${schema.eventSessions.isBounce})`.as('bounces'),
			pageviews: sql<number>`SUM(${schema.eventSessions.pageviews})`.as('pageviews'),
			duration: sql<number>`SUM(${schema.eventSessions.durationMs})`.as('duration'),
		})
		.from(schema.eventSessions)
		.where(buildSessionWhere(f));
}

function mapEngagement(row?: Record<string, unknown>): EngagementSummary {
	const sessions = Number(row?.sessions ?? 0);
	if (sessions === 0) {
		return {
			sessions: 0,
			bounce_rate: 0,
			pages_per_session: 0,
			avg_duration_ms: 0,
		};
	}
	return {
		sessions,
		bounce_rate: Number(row?.bounces ?? 0) / sessions,
		pages_per_session: Number(row?.pageviews ?? 0) / sessions,
		avg_duration_ms: Number(row?.duration ?? 0) / sessions,
	};
}

/** Session engagement metrics over the range; all zero when there are no sessions. */
export async function engagement(env: Env, f: StatsFilter): Promise<EngagementSummary> {
	return mapEngagement(await engagementQuery(env, f).get());
}

/** Engagement-only read for the optional session tile. */
export async function engagementStats(
	env: Env,
	f: StatsFilter,
): Promise<StatsRead<StatsEngagementResponse>> {
	const { rows, metrics } = await statsBatch(env, [engagementQuery(env, f)]);
	return { data: { engagement: mapEngagement(rows[0]?.[0]) }, metrics };
}

/** Sessions grouped by acquisition channel, excluding `internal` and NULL, count desc. */
function channelsQuery(env: Env, f: StatsFilter) {
	const count = sql<number>`COUNT(*)`;
	return db(env)
		.select({
			key: sql`${schema.eventSessions.channel}`.as('key'),
			count: count.as('count'),
		})
		.from(schema.eventSessions)
		.where(
			and(
				buildSessionWhere(f),
				isNotNull(schema.eventSessions.channel),
				ne(schema.eventSessions.channel, 'internal'),
			),
		)
		.groupBy(schema.eventSessions.channel)
		.orderBy(desc(count), schema.eventSessions.channel);
}

/** Sessions grouped by acquisition channel, excluding `internal` and NULL, count desc. */
export async function channels(env: Env, f: StatsFilter): Promise<CountRow[]> {
	return mapCountRows(await channelsQuery(env, f));
}

/** The six lists rendered by Realtime, batched into one D1 round-trip. */
export async function realtimeContext(
	env: Env,
	f: StatsFilter,
): Promise<StatsRead<RealtimeContextResponse>> {
	const { rows, metrics } = await statsBatch(env, [
		topByColumnQuery(env, f, schema.events.path, { limit: 10 }),
		topByColumnQuery(env, f, schema.events.name, {
			excludeNull: true,
			limit: 10,
			extra: isCustomEvent,
		}),
		topByColumnQuery(env, f, schema.events.referrer, {
			excludeEmpty: true,
			limit: 10,
		}),
		topByColumnQuery(env, f, schema.events.country, { excludeNull: true, limit: 10 }),
		topByColumnQuery(env, f, schema.events.device, { excludeNull: true }),
		topByColumnQuery(env, f, schema.events.channel, {
			excludeNull: true,
			extra: ne(schema.events.channel, 'internal'),
		}),
	]);
	return {
		data: {
			top_paths: mapCountRows(rows[0] ?? []),
			top_events: mapCountRows(rows[1] ?? []),
			top_referrers: mapCountRows(rows[2] ?? []),
			top_countries: mapCountRows(rows[3] ?? []),
			top_devices: mapCountRows(rows[4] ?? []),
			channels: mapCountRows(rows[5] ?? []),
		},
		metrics,
	};
}

/** Cohorts (and the trailing retention columns) are hard-capped so the matrix stays bounded and the
 * response never grows with the range — the SQL over `sessions` is unbounded, so we window it here. */
const COHORT_MAX_PERIODS = 12;

/** Cap on (visitor, day_key) rows scanned for the retention triangle — same defensive bound as
 * `ATTRIBUTION_MAX_EVENTS`, for a very wide range. Ordered oldest-first so a truncated range drops
 * only the newest cohorts, which haven't had time to show multi-period retention anyway. */
const COHORT_MAX_ROWS = 100_000;

const SALT_WINDOW_NOTE =
	'Retention depth is bounded by the site salt window: a visitor_hash is stable only within one ' +
	'window (default: daily). At the daily window a returning person gets a new hash each day, so ' +
	'multi-period retention is legitimately ~0. Wider (weekly/monthly) retention requires a wider ' +
	'salt window via the identity spectrum.';

/** Convert a `YYYY-MM-DD` day_key to a UTC-midnight unix-ms timestamp. */
function dayKeyToMs(dayKey: string): number {
	return Date.parse(`${dayKey}T00:00:00.000Z`);
}

const WEEK_MS = 7 * DAY_MS;

/** Snap a UTC-midnight timestamp to the start of its period bucket: the day itself, or (for `week`)
 * its ISO-week Monday. UTC epoch (1970-01-01) was a Thursday, so shifting by 4 days lands Monday on
 * the week boundary. Input is already day-aligned, so `t % DAY_MS === 0`. */
function bucketStart(ms: number, period: CohortPeriod): number {
	if (period === 'day') {
		return ms;
	}
	return ms - ((ms / DAY_MS + 3) % 7) * DAY_MS;
}

/** Format a period-bucket start (unix ms) as its `YYYY-MM-DD` cohort label. */
function cohortLabel(startMs: number): string {
	return new Date(startMs).toISOString().slice(0, 10);
}

/**
 * Cohort-retention triangle over the `sessions` table for a site+range. Visitors are grouped by the
 * period (`day`|`week`) of their FIRST activity; each retention column is the fraction of that cohort
 * seen n periods later. A visitor_hash is stable only within one salt window, so at the default daily
 * window cross-period retention is honestly ~0 (see `SALT_WINDOW_NOTE`).
 *
 * The read is a bounded per-(visitor, day_key) scan; bucketing into periods and the retention matrix
 * are computed in JS. Output is capped at the last `COHORT_MAX_PERIODS` cohorts, each with at most
 * `COHORT_MAX_PERIODS` retention columns, so the response never grows with the range.
 */
export async function cohortRetention(
	env: Env,
	f: StatsFilter,
	period: CohortPeriod,
): Promise<CohortRetentionResponse> {
	// One row per (visitor, day_key) they were active. day_key is the stable-within-window bucket.
	const rows = await db(env)
		.select({
			visitorHash: schema.sessions.visitorHash,
			dayKey: schema.sessions.dayKey,
		})
		.from(schema.sessions)
		.where(
			and(
				eq(schema.sessions.siteId, f.siteId),
				gte(schema.sessions.firstSeen, f.start),
				lt(schema.sessions.firstSeen, f.end),
			),
		)
		.orderBy(schema.sessions.firstSeen)
		.limit(COHORT_MAX_ROWS);

	if (rows.length === 0) {
		return { period, cohorts: [], note: SALT_WINDOW_NOTE };
	}

	const periodMs = period === 'day' ? DAY_MS : WEEK_MS;
	// Origin: the bucket-start of the earliest active day, so bucket indices start at 0.
	let earliestDayMs = Number.POSITIVE_INFINITY;
	for (const r of rows) {
		const ms = dayKeyToMs(String(r.dayKey));
		if (ms < earliestDayMs) earliestDayMs = ms;
	}
	const originStart = bucketStart(earliestDayMs, period);

	// Per visitor: their first bucket (cohort) and the full set of buckets they appear in.
	const byVisitor = new Map<string, { first: number; seen: Set<number> }>();
	for (const r of rows) {
		const idx = Math.floor(
			(bucketStart(dayKeyToMs(String(r.dayKey)), period) - originStart) / periodMs,
		);
		const key = String(r.visitorHash);
		const entry = byVisitor.get(key);
		if (entry) {
			entry.first = Math.min(entry.first, idx);
			entry.seen.add(idx);
		} else {
			byVisitor.set(key, { first: idx, seen: new Set([idx]) });
		}
	}

	// Cohort → size and per-offset returning counts.
	const cohorts = new Map<number, { size: number; returned: Map<number, number> }>();
	for (const { first, seen } of byVisitor.values()) {
		let cohort = cohorts.get(first);
		if (!cohort) {
			cohort = { size: 0, returned: new Map() };
			cohorts.set(first, cohort);
		}
		cohort.size += 1;
		for (const idx of seen) {
			const offset = idx - first;
			if (offset >= 0 && offset < COHORT_MAX_PERIODS) {
				cohort.returned.set(offset, (cohort.returned.get(offset) ?? 0) + 1);
			}
		}
	}

	// Keep only the most recent COHORT_MAX_PERIODS cohorts, ascending by period.
	const cohortIdxs = [...cohorts.keys()].sort((a, b) => a - b).slice(-COHORT_MAX_PERIODS);
	const result: CohortRow[] = cohortIdxs.map((idx) => {
		const c = cohorts.get(idx) as {
			size: number;
			returned: Map<number, number>;
		};
		const retention: number[] = [];
		for (let offset = 0; offset < COHORT_MAX_PERIODS; offset++) {
			const n = c.returned.get(offset) ?? 0;
			if (offset > 0 && n === 0) {
				break;
			}
			retention.push(c.size > 0 ? n / c.size : 0);
		}
		return {
			cohort: cohortLabel(originStart + idx * periodMs),
			size: c.size,
			retention,
		};
	});

	return { period, cohorts: result, note: SALT_WINDOW_NOTE };
}
