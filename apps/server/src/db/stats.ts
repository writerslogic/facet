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
	EngagementSummary,
	Freshness,
	Interval,
	RealtimeSnapshot,
	RevenueSummary,
	SeriesPoint,
	StatsFilter,
	StatsSummary,
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
 * Note: `cube` deliberately uses `buildEventWhere` directly (it excludes path/referrer by design). */
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

/** Pageviews (name IS NULL), custom events (name IS NOT NULL), and distinct visitors. */
export async function summary(env: Env, f: StatsFilter): Promise<StatsSummary> {
	const row = await db(env)
		.select({
			pageviews: pageviewCount,
			events: eventCount,
			visitors: visitorCount,
		})
		.from(schema.events)
		.where(buildFilteredEventWhere(f))
		.get();
	return {
		pageviews: Number(row?.pageviews ?? 0),
		events: Number(row?.events ?? 0),
		visitors: Number(row?.visitors ?? 0),
	};
}

/** Time series bucketed by hour/day, ascending, with every empty bucket in [start, end) zero-filled. */
export async function series(env: Env, f: StatsFilter, interval: Interval): Promise<SeriesPoint[]> {
	const bucketMs = interval === 'hour' ? HOUR_MS : DAY_MS;
	const bucket = sql<number>`(${schema.events.createdAt} - (${schema.events.createdAt} % ${bucketMs}))`;
	const rows = await db(env)
		.select({ t: bucket, pageviews: pageviewCount, visitors: visitorCount })
		.from(schema.events)
		.where(buildFilteredEventWhere(f))
		.groupBy(bucket)
		.orderBy(bucket);
	const byBucket = new Map<number, { pageviews: number; visitors: number }>();
	for (const r of rows) {
		byBucket.set(Number(r.t), {
			pageviews: Number(r.pageviews ?? 0),
			visitors: Number(r.visitors ?? 0),
		});
	}
	const points: SeriesPoint[] = [];
	for (let b = f.start - (f.start % bucketMs); b < f.end; b += bucketMs) {
		const hit = byBucket.get(b);
		points.push({
			t: b,
			pageviews: hit?.pageviews ?? 0,
			visitors: hit?.visitors ?? 0,
		});
	}
	return points;
}

/** How many countries the cube keeps distinct before folding the long tail into `'other'`. */
const CUBE_TOP_COUNTRIES = 30;

/** A small dimensional cube for the range: per (bucket, device, country, channel) counts, for instant
 * client-side slicing by those low-cardinality axes with no further server reads. Country is folded to
 * the top-N by volume plus `'other'`, so the cube is both bounded AND complete (every event lands in a
 * cell — totals stay exact). Path/referrer are deliberately excluded (high cardinality → server-side). */
export async function cube(env: Env, f: StatsFilter, interval: Interval): Promise<CubeCell[]> {
	const bucketMs = interval === 'hour' ? HOUR_MS : DAY_MS;
	const bucket = sql<number>`(${schema.events.createdAt} - (${schema.events.createdAt} % ${bucketMs}))`;

	// Bound country cardinality without dropping data: keep the top-N countries, fold the rest to 'other'.
	// IMPORTANT: rank over the same unfiltered rows the cube itself reads. Ranking under an active
	// country/device/channel filter would fold every other country into 'other' and destroy the axis
	// the client slices on — the one thing this endpoint exists to provide.
	const unfiltered: StatsFilter = {
		siteId: f.siteId,
		hostname: f.hostname,
		start: f.start,
		end: f.end,
	};
	const topCountries = (
		await topByColumn(env, unfiltered, schema.events.country, {
			excludeNull: true,
			limit: CUBE_TOP_COUNTRIES,
		})
	).map((r) => r.key);
	const country =
		topCountries.length > 0
			? sql<string>`CASE WHEN ${schema.events.country} IN (${sql.join(
					topCountries.map((c) => sql`${c}`),
					sql`, `,
				)}) THEN ${schema.events.country} ELSE 'other' END`
			: sql<string>`COALESCE(${schema.events.country}, 'other')`;
	const device = sql<string>`COALESCE(${schema.events.device}, 'unknown')`;
	const channel = sql<string>`COALESCE(${schema.events.channel}, 'unknown')`;

	const rows = await db(env)
		.select({
			t: bucket,
			device,
			country,
			channel,
			pageviews: pageviewCount,
			events: eventCount,
			visitors: visitorCount,
		})
		.from(schema.events)
		.where(buildEventWhere(f))
		.groupBy(bucket, device, country, channel);

	return rows.map((r) => ({
		t: Number(r.t),
		device: String(r.device),
		country: String(r.country),
		channel: String(r.channel),
		pageviews: Number(r.pageviews ?? 0),
		events: Number(r.events ?? 0),
		visitors: Number(r.visitors ?? 0),
	}));
}

/** Shared top-N count over one column, sorted by count desc (key asc for stable ties). */
async function topByColumn(
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
): Promise<CountRow[]> {
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
		.select({ key: column, count })
		.from(schema.events)
		.where(and(...conditions))
		.groupBy(column);
	const bounded = opts.minCount ? grouped.having(sql`COUNT(*) >= ${opts.minCount}`) : grouped;
	const rows = await bounded.orderBy(desc(count), column).limit(opts.limit ?? 1000);
	return rows.map((r) => ({ key: String(r.key), count: Number(r.count) }));
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

/** Ecommerce revenue over the range. Grouped by currency and reporting the dominant one, so total /
 * orders / AOV are always currency-consistent (correct for single-currency sites; the top currency for
 * mixed). `orders` counts valued events. */
export async function revenue(env: Env, f: StatsFilter): Promise<RevenueSummary> {
	const total = sql<number>`SUM(${schema.events.value})`;
	const rows = await db(env)
		.select({
			currency: schema.events.currency,
			total,
			orders: sql<number>`COUNT(${schema.events.value})`,
		})
		.from(schema.events)
		.where(and(buildFilteredEventWhere(f), isNotNull(schema.events.value)))
		.groupBy(schema.events.currency)
		.orderBy(desc(total));
	const top = rows[0];
	const totalValue = Number(top?.total ?? 0);
	const orders = Number(top?.orders ?? 0);
	return {
		total: totalValue,
		orders,
		aov: orders > 0 ? totalValue / orders : 0,
		currency: top?.currency ?? null,
	};
}

/** Revenue summed per channel, k-anonymised on order count so a channel with too few orders is not
 * surfaced. `count` carries the (rounded) revenue so it renders through the shared ranked-list boxes. */
export async function revenueByChannel(env: Env, f: StatsFilter, limit = 12): Promise<CountRow[]> {
	const sum = sql<number>`SUM(${schema.events.value})`;
	const rows = await db(env)
		.select({ key: schema.events.channel, sum })
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
	return rows.map((r) => ({
		key: String(r.key),
		count: Math.round(Number(r.sum)),
	}));
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
export async function attribution(env: Env, f: StatsFilter): Promise<AttributionResult> {
	const rows = await db(env)
		.select({
			vh: schema.events.visitorHash,
			at: schema.events.createdAt,
			channel: schema.events.channel,
			value: schema.events.value,
		})
		.from(schema.events)
		.where(and(buildFilteredEventWhere(f), isNotNull(schema.events.channel)))
		.orderBy(schema.events.visitorHash, schema.events.createdAt)
		.limit(ATTRIBUTION_MAX_EVENTS);
	// Group rows into (visitor, UTC day) paths. Rows arrive ordered by (visitor, time), so each group's
	// channels are already in touch order.
	const groups = new Map<string, { channels: string[]; value: number; converted: boolean }>();
	for (const r of rows) {
		const day = Math.floor(Number(r.at) / DAY_MS);
		const key = `${r.vh}|${day}`;
		let g = groups.get(key);
		if (!g) {
			g = { channels: [], value: 0, converted: false };
			groups.set(key, g);
		}
		if (r.channel) g.channels.push(String(r.channel));
		const v = r.value == null ? null : Number(r.value);
		if (v != null && Number.isFinite(v) && v > 0) {
			g.value += v;
			g.converted = true;
		}
	}
	return computeAttribution([...groups.values()]);
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
	const [rawRow, sessionRow] = await Promise.all([
		db(env)
			.select({ latest: sql<number | null>`MAX(${schema.events.createdAt})` })
			.from(schema.events)
			.where(buildEventWhere(f))
			.get(),
		db(env)
			.select({ latest: sql<number | null>`MAX(${schema.eventSessions.endedAt})` })
			.from(schema.eventSessions)
			.where(
				and(
					eq(schema.eventSessions.siteId, f.siteId),
					gte(schema.eventSessions.startedAt, f.start - SESSION_TIMEOUT_MS),
					lt(schema.eventSessions.startedAt, f.end),
				),
			)
			.get(),
	]);
	const latestEvent = rawRow?.latest == null ? null : Number(rawRow.latest);
	const latestSession = sessionRow?.latest == null ? null : Number(sessionRow.latest);
	return {
		materialization: 'hourly',
		pending: latestEvent !== null && (latestSession === null || latestEvent > latestSession),
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

/** Session engagement metrics over the range; all zero when there are no sessions. */
export async function engagement(env: Env, f: StatsFilter): Promise<EngagementSummary> {
	const row = await db(env)
		.select({
			sessions: sql<number>`COUNT(*)`,
			bounces: sql<number>`SUM(${schema.eventSessions.isBounce})`,
			pageviews: sql<number>`SUM(${schema.eventSessions.pageviews})`,
			duration: sql<number>`SUM(${schema.eventSessions.durationMs})`,
		})
		.from(schema.eventSessions)
		.where(buildSessionWhere(f))
		.get();
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

/** Sessions grouped by acquisition channel, excluding `internal` and NULL, count desc. */
export async function channels(env: Env, f: StatsFilter): Promise<CountRow[]> {
	const count = sql<number>`COUNT(*)`;
	const rows = await db(env)
		.select({ key: schema.eventSessions.channel, count })
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
	return rows.map((r) => ({ key: String(r.key), count: Number(r.count) }));
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
