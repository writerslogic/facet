// Stats aggregation over the indexed `events` table. Every helper composes `buildEventWhere` and
// reads via Drizzle `sql` helpers (COUNT(DISTINCT …), bucket math) — no raw string SQL. Time is
// unix ms; ranges are [start, end).

import type {
	CountRow,
	EngagementSummary,
	Interval,
	SeriesPoint,
	StatsFilter,
	StatsSummary,
} from '@facet/shared';
import { type SQL, and, desc, eq, gte, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Env } from '../env.js';
import { DAY_MS, HOUR_MS } from '../lib/constants.js';
import { buildEventWhere } from './filters.js';
import { db } from './queries.js';
import * as schema from './schema.js';

const pageviewCount = sql<number>`SUM(CASE WHEN ${schema.events.name} IS NULL THEN 1 ELSE 0 END)`;
const eventCount = sql<number>`SUM(CASE WHEN ${schema.events.name} IS NOT NULL THEN 1 ELSE 0 END)`;
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
		.where(buildEventWhere(f))
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
		.where(buildEventWhere(f))
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

/** Shared top-N count over one column, sorted by count desc (key asc for stable ties). */
async function topByColumn(
	env: Env,
	f: StatsFilter,
	column: SQLiteColumn,
	opts: { excludeNull?: boolean; excludeEmpty?: boolean; limit?: number } = {},
): Promise<CountRow[]> {
	const conditions: SQL[] = [buildEventWhere(f)];
	if (opts.excludeNull) {
		conditions.push(isNotNull(column));
	}
	if (opts.excludeEmpty) {
		conditions.push(ne(column, ''));
	}
	const count = sql<number>`COUNT(*)`;
	const rows = await db(env)
		.select({ key: column, count })
		.from(schema.events)
		.where(and(...conditions))
		.groupBy(column)
		.orderBy(desc(count), column)
		.limit(opts.limit ?? 1000);
	return rows.map((r) => ({ key: String(r.key), count: Number(r.count) }));
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

export function topEvents(env: Env, f: StatsFilter, limit = 10): Promise<CountRow[]> {
	return topByColumn(env, f, schema.events.name, { excludeNull: true, limit });
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
function buildSessionWhere(f: StatsFilter): SQL {
	return and(
		eq(schema.eventSessions.siteId, f.siteId),
		gte(schema.eventSessions.startedAt, f.start),
		lt(schema.eventSessions.startedAt, f.end),
	) as SQL;
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
