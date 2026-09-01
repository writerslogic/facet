// Rollup aggregation: fold raw `events` into `event_rollups` (hourly + daily). Every bucket lies
// entirely within one UTC day and therefore one salt, so COUNT(DISTINCT visitor_hash) inside a
// bucket is always computed under a single consistent salt (no cross-day lookback).
// Idempotent: re-running a bucket overwrites its row with identical counts.

import type { Interval } from '@facet/shared';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { DAY_MS, HOUR_MS } from './constants.js';
import { retentionDays } from './retention.js';

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
	const client = db(env);
	const rows = await client
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

	if (rows.length === 0) return;

	// One batched D1 round-trip for every (site, hostname) upsert instead of one round-trip per row
	// (see transparency.ts's node/leaf insert for the same pattern). D1 runs a batch as one atomic
	// transaction, which is also stronger than the prior per-row awaits: either every bucket in this
	// tick lands or none do, rather than a partial rollup on a mid-loop failure.
	const stmts = rows.map((r) => {
		const pageviews = Number(r.pageviews ?? 0);
		const events = Number(r.events ?? 0);
		const visitors = Number(r.visitors ?? 0);
		return client
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
	});
	await client.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
}

/** Completed buckets one tick may reconstruct. A fixed lookback anchored on the newest complete
 * bucket, so a walk costs the same whether the previous tick ran or a hundred did not — an outage
 * longer than the window slides out of it and is not reconstructed. */
const MAX_CATCHUP_HOURS = 6;
const MAX_CATCHUP_DAYS = 2;

/** The `bucket_start`s already written at `interval` within `[from, to)`. */
async function writtenBuckets(
	env: Env,
	interval: Interval,
	from: number,
	to: number,
): Promise<Set<number>> {
	const rows = await db(env)
		.selectDistinct({ bucketStart: schema.eventRollups.bucketStart })
		.from(schema.eventRollups)
		.where(
			and(
				eq(schema.eventRollups.interval, interval),
				gte(schema.eventRollups.bucketStart, from),
				lt(schema.eventRollups.bucketStart, to),
			),
		);
	return new Set(rows.map((r) => r.bucketStart));
}

/**
 * Write every bucket that has no row yet, from `newest` back over at most `maxBuckets`.
 *
 * IMPORTANT: gap-fill, never re-upsert. `transparency.ts` hashes a rollup row's counters into an
 * append-only MMR leaf in the same cron tick the row is written, and `mmr_leaves.rollup_key` is
 * unique, so a rewritten row would silently disagree with the leaf already signed over it. A bucket
 * with no row was never a log candidate, so creating one is the only safe repair.
 *
 * `floor` is the raw-retention cutoff: below it the source events are partly purged already, and
 * rolling such a bucket would commit an undercount as though it were the true total.
 */
async function fillBuckets(
	env: Env,
	interval: Interval,
	newest: number,
	size: number,
	maxBuckets: number,
	floor: number,
): Promise<void> {
	// REQUIRED: round the floor UP onto the bucket grid. Rounding down would start a bucket before the
	// retention cutoff (the undercount this clamp exists to stop), and not rounding at all would emit a
	// `day` row starting at some arbitrary hour — a window straddling the UTC boundary, and so two
	// salts, which is exactly what makes COUNT(DISTINCT visitor_hash) meaningless.
	const oldest = Math.max(newest - (maxBuckets - 1) * size, Math.ceil(floor / size) * size);
	if (oldest > newest) return;
	const written = await writtenBuckets(env, interval, oldest, newest + size);
	for (let start = oldest; start <= newest; start += size) {
		if (written.has(start)) continue;
		await rollupBucket(env, interval, start, start + size);
	}
}

/**
 * Fill in every completed hour and day still missing a rollup row.
 *
 * IMPORTANT: a bucket gets exactly one chance under a fixed `now`, and the cron never re-delivers a
 * missed tick — `scheduled.ts` retries a failed job with a NEW `now`, not the one it failed on. So a
 * single throw used to lose that hour permanently, and because the day pass sat behind the hour pass
 * both in `await` order and behind a one-tick-per-UTC-day gate, a throw at 00:00 lost the whole
 * preceding day as well. The holes were silent: `db/coarsen.ts`'s day-to-hour fallback finds neither.
 * The walks are therefore independent, and failures are collected and re-thrown so `runScheduled`
 * still records the job as failed.
 */
export async function runRollups(env: Env, now: number): Promise<void> {
	const floor = now - retentionDays(env) * DAY_MS;
	const errors: unknown[] = [];
	const walk = async (fn: () => Promise<void>): Promise<void> => {
		try {
			await fn();
		} catch (err) {
			errors.push(err);
		}
	};

	const lastHour = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
	await walk(() => fillBuckets(env, 'hour', lastHour, HOUR_MS, MAX_CATCHUP_HOURS, floor));
	const lastDay = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
	await walk(() => fillBuckets(env, 'day', lastDay, DAY_MS, MAX_CATCHUP_DAYS, floor));

	if (errors.length > 0) {
		const detail = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
		throw new AggregateError(errors, `runRollups: ${errors.length} walk(s) failed: ${detail}`);
	}
}
