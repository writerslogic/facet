// Rollup aggregation: fold raw `events` into `event_rollups` (hourly + daily). Every bucket lies
// entirely within one UTC day and therefore one salt, so COUNT(DISTINCT visitor_hash) inside a
// bucket is always computed under a single consistent salt (no cross-day lookback).
// Idempotent: re-running a bucket overwrites its row with identical counts.

import type { Interval } from '@facet/shared';
import { and, gte, lt, sql } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { DAY_MS, HOUR_MS } from './constants.js';

const pageviewCount = sql<number>`SUM(CASE WHEN ${schema.events.name} IS NULL THEN 1 ELSE 0 END)`;
const eventCount = sql<number>`SUM(CASE WHEN ${schema.events.name} IS NOT NULL THEN 1 ELSE 0 END)`;
const visitorCount = sql<number>`COUNT(DISTINCT ${schema.events.visitorHash})`;

/** Aggregate every (site, hostname) with events in [bucketStart, bucketEnd) into one rollup row.
 * NOTE: `visitors` is COUNT(DISTINCT visitor) per (site, hostname, bucket) and is NOT additive across
 * hostnames — a visitor on two hosts of one site counts once per host. For a site-level unique count,
 * recompute COUNT(DISTINCT) from raw events (as db/stats.ts does); never SUM rollup `visitors`. */
export async function rollupBucket(
	env: Env,
	interval: Interval,
	bucketStart: number,
	bucketEnd: number,
): Promise<void> {
	const rows = await db(env)
		.select({
			siteId: schema.events.siteId,
			hostname: schema.events.hostname,
			pageviews: pageviewCount,
			events: eventCount,
			visitors: visitorCount,
		})
		.from(schema.events)
		.where(
			and(gte(schema.events.createdAt, bucketStart), lt(schema.events.createdAt, bucketEnd)),
		)
		.groupBy(schema.events.siteId, schema.events.hostname);

	for (const r of rows) {
		const pageviews = Number(r.pageviews ?? 0);
		const events = Number(r.events ?? 0);
		const visitors = Number(r.visitors ?? 0);
		await db(env)
			.insert(schema.eventRollups)
			.values({
				siteId: r.siteId,
				hostname: r.hostname,
				bucketStart,
				interval,
				pageviews,
				events,
				visitors,
			})
			.onConflictDoUpdate({
				target: [
					schema.eventRollups.siteId,
					schema.eventRollups.hostname,
					schema.eventRollups.bucketStart,
					schema.eventRollups.interval,
				],
				set: { pageviews, events, visitors },
			});
	}
}

/** Roll up the most recently completed hour, plus the completed day at each UTC midnight. */
export async function runRollups(env: Env, now: number): Promise<void> {
	const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
	await rollupBucket(env, 'hour', hourStart, hourStart + HOUR_MS);

	// Within the first hour of a UTC day, the previous day is now complete: roll it up too.
	if (now % DAY_MS < HOUR_MS) {
		const dayStart = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
		await rollupBucket(env, 'day', dayStart, dayStart + DAY_MS);
	}
}
