// Tiered-granularity reads and writes over `event_rollups`. Sources are only ever read here; the
// coarse row is written as an absolute total, never an increment.

import type { Env } from '../env.js';
import { D1_MAX_IN_PARAMS, DAY_MS, chunked } from '../lib/constants.js';
import { db } from './queries.js';
import * as schema from './schema.js';

/** A coarse interval `event_rollups` can hold beyond the `hour`/`day` grid `lib/rollups.ts` writes. */
export type CoarseInterval = 'month' | 'year';

/** One (site, hostname) total for a single coarse period. */
export interface CoarseTotal {
	site_id: string;
	hostname: string;
	pageviews: number;
	events: number;
}

/**
 * Per-(site, hostname) totals for the fine rows inside `[periodStart, periodEnd)`, for pairs that do
 * not already have a coarse row at `periodStart`.
 *
 * IMPORTANT: hour and day rows are two views of the SAME raw events, so summing both double-counts.
 * The inner grouping resolves each UTC day to its `day` row when one exists and falls back to that
 * day's `hour` rows when the daily pass never ran for it.
 */
export async function sumFineForPeriod(
	env: Env,
	periodStart: number,
	periodEnd: number,
): Promise<CoarseTotal[]> {
	const { results } = await env.DB.prepare(
		`SELECT site_id, hostname,
			SUM(CASE WHEN n_day > 0 THEN d_pv ELSE h_pv END) AS pageviews,
			SUM(CASE WHEN n_day > 0 THEN d_ev ELSE h_ev END) AS events
		FROM (
			SELECT site_id, hostname, bucket_start / ${DAY_MS} AS day_key,
				SUM(CASE WHEN interval = 'day' THEN pageviews ELSE 0 END) AS d_pv,
				SUM(CASE WHEN interval = 'day' THEN events ELSE 0 END) AS d_ev,
				SUM(CASE WHEN interval = 'hour' THEN pageviews ELSE 0 END) AS h_pv,
				SUM(CASE WHEN interval = 'hour' THEN events ELSE 0 END) AS h_ev,
				SUM(CASE WHEN interval = 'day' THEN 1 ELSE 0 END) AS n_day
			FROM event_rollups
			WHERE interval IN ('hour', 'day') AND bucket_start >= ? AND bucket_start < ?
			GROUP BY site_id, hostname, day_key
		) AS d
		WHERE NOT EXISTS (
			SELECT 1 FROM event_rollups c
			WHERE c.site_id = d.site_id AND c.hostname = d.hostname
				AND c.bucket_start = ? AND c.interval = 'month'
		)
		GROUP BY site_id, hostname`,
	)
		.bind(periodStart, periodEnd, periodStart)
		.all<CoarseTotal>();
	return results;
}

/** Per-(site, hostname) totals for the `month` rows inside `[periodStart, periodEnd)`, for pairs that
 * do not already have a `year` row at `periodStart`. */
export async function sumMonthsForPeriod(
	env: Env,
	periodStart: number,
	periodEnd: number,
): Promise<CoarseTotal[]> {
	const { results } = await env.DB.prepare(
		`SELECT m.site_id AS site_id, m.hostname AS hostname,
			SUM(m.pageviews) AS pageviews, SUM(m.events) AS events
		FROM event_rollups m
		WHERE m.interval = 'month' AND m.bucket_start >= ? AND m.bucket_start < ?
			AND NOT EXISTS (
				SELECT 1 FROM event_rollups c
				WHERE c.site_id = m.site_id AND c.hostname = m.hostname
					AND c.bucket_start = ? AND c.interval = 'year'
			)
		GROUP BY m.site_id, m.hostname`,
	)
		.bind(periodStart, periodEnd, periodStart)
		.all<CoarseTotal>();
	return results;
}

/** Oldest `bucket_start` at or after `from` across the given intervals, or null when none remain.
 * Lets a tier's walk jump a quiet stretch in one query instead of spending its per-run budget
 * stepping through periods that hold no source rows at all. */
export async function nextBucketStartAtOrAfter(
	env: Env,
	intervals: readonly string[],
	from: number,
): Promise<number | null> {
	const list = intervals.map(() => '?').join(', ');
	const row = await env.DB.prepare(
		`SELECT MIN(bucket_start) AS b FROM event_rollups WHERE interval IN (${list}) AND bucket_start >= ?`,
	)
		.bind(...intervals, from)
		.first<{ b: number | null }>();
	return row?.b ?? null;
}

/** Newest `bucket_start` at one interval, or null when none exist. */
export async function newestBucketStart(env: Env, interval: string): Promise<number | null> {
	const row = await env.DB.prepare(
		'SELECT MAX(bucket_start) AS b FROM event_rollups WHERE interval = ?',
	)
		.bind(interval)
		.first<{ b: number | null }>();
	return row?.b ?? null;
}

/**
 * Upsert one coarse row per total at `periodStart`. `set` writes every counter absolutely, so a
 * repeat of the same period converges on the recomputed value instead of accumulating.
 */
export async function writeCoarseRollups(
	env: Env,
	interval: CoarseInterval,
	periodStart: number,
	totals: readonly CoarseTotal[],
): Promise<void> {
	if (totals.length === 0) return;
	const client = db(env);
	// PERF: one batched round-trip per chunk rather than per row, bounded so a single statement list
	// cannot grow with the table.
	for (const chunk of chunked(totals, D1_MAX_IN_PARAMS)) {
		const stmts = chunk.map((t) => {
			const pageviews = Number(t.pageviews ?? 0);
			const events = Number(t.events ?? 0);
			return client
				.insert(schema.eventRollups)
				.values({
					siteId: t.site_id,
					hostname: t.hostname,
					bucketStart: periodStart,
					interval,
					pageviews,
					events,
					// IMPORTANT: uniques are not re-derivable once raw `events` age past
					// RAW_RETENTION_DAYS, and summing daily uniques is not a monthly unique count, so a
					// summed value here would be false precision. Zero, explicitly, on both paths.
					visitors: 0,
				})
				.onConflictDoUpdate({
					target: [
						schema.eventRollups.siteId,
						schema.eventRollups.hostname,
						schema.eventRollups.bucketStart,
						schema.eventRollups.interval,
					],
					set: { pageviews, events, visitors: 0 },
				});
		});
		await client.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
	}
}
