// Anomaly detection + root-cause "autopsy" over the hourly pageview series. Runs entirely over
// aggregate `events` data (no per-user identity), scores the most recent hour against a baseline of
// earlier hours via a sample z-score, and picks the dimension value that most drove the deviation.
// The plain-language summary is a deterministic template (no LLM) so it is fully testable.

import type { Anomaly, StatsFilter } from '@facet/shared';
import { type SQL, and, isNotNull, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Env } from '../env.js';
import { ANOMALY_MIN_BASELINE, ANOMALY_Z, HOUR_MS } from '../lib/constants.js';
import { buildEventWhere } from './filters.js';
import { db } from './queries.js';
import * as schema from './schema.js';

type Dimension = 'device' | 'country' | 'channel';

const DIMENSIONS: { dimension: Dimension; column: SQLiteColumn }[] = [
	{ dimension: 'device', column: schema.events.device },
	{ dimension: 'country', column: schema.events.country },
	{ dimension: 'channel', column: schema.events.channel },
];

/** Zero-filled hourly pageview counts over [start, end), aligned to `t - (t % HOUR_MS)`. */
async function hourlyPageviews(
	env: Env,
	f: StatsFilter,
): Promise<{ bucket: number; value: number }[]> {
	const bucket = sql<number>`(${schema.events.createdAt} - (${schema.events.createdAt} % ${HOUR_MS}))`;
	const count = sql<number>`SUM(CASE WHEN ${schema.events.name} IS NULL THEN 1 ELSE 0 END)`;
	const rows = await db(env)
		.select({ t: bucket, pageviews: count })
		.from(schema.events)
		.where(buildEventWhere(f))
		.groupBy(bucket)
		.orderBy(bucket);
	const byBucket = new Map<number, number>();
	for (const r of rows) {
		byBucket.set(Number(r.t), Number(r.pageviews ?? 0));
	}
	const points: { bucket: number; value: number }[] = [];
	for (let b = f.start - (f.start % HOUR_MS); b < f.end; b += HOUR_MS) {
		points.push({ bucket: b, value: byBucket.get(b) ?? 0 });
	}
	return points;
}

/** Per-value pageview counts for one dimension over a [start, end) window, excluding NULLs. */
async function dimensionCounts(
	env: Env,
	f: StatsFilter,
	column: SQLiteColumn,
): Promise<Map<string, number>> {
	const count = sql<number>`SUM(CASE WHEN ${schema.events.name} IS NULL THEN 1 ELSE 0 END)`;
	const rows = await db(env)
		.select({ key: column, count })
		.from(schema.events)
		.where(and(buildEventWhere(f), isNotNull(column)) as SQL)
		.groupBy(column);
	const out = new Map<string, number>();
	for (const r of rows) {
		out.set(String(r.key), Number(r.count ?? 0));
	}
	return out;
}

/** Sample mean and sample stddev (n-1) over a list of numbers. */
function meanStddev(xs: number[]): { mean: number; stddev: number } {
	const n = xs.length;
	const mean = xs.reduce((a, b) => a + b, 0) / n;
	const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
	return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Detect a pageview anomaly in the most recent hour of [f.start, f.end). Returns a single-element
 * array when the last completed bucket deviates by at least ANOMALY_Z from the baseline, else [].
 *
 * The in-progress hour (any bucket whose full `HOUR_MS` has not elapsed as of `now`) is excluded
 * from both the candidate and the baseline, so partial current-hour data can't fabricate a "drop".
 * `now` is a deterministic UTC-ms clock, passed explicitly for testability; for purely historical
 * ranges (end already in the past) the filter is a no-op.
 */
export async function detectAnomalies(env: Env, f: StatsFilter, now: number): Promise<Anomaly[]> {
	const all = await hourlyPageviews(env, f);
	const points = all.filter((p) => p.bucket + HOUR_MS <= now);
	if (points.length < 1) {
		return [];
	}
	const candidate = points[points.length - 1];
	if (!candidate) {
		return [];
	}
	const baseline = points.slice(0, -1);
	if (baseline.length < ANOMALY_MIN_BASELINE) {
		return [];
	}
	const { mean, stddev } = meanStddev(baseline.map((p) => p.value));
	if (stddev === 0) {
		return [];
	}
	const value = candidate.value;
	const z = (value - mean) / stddev;
	if (Math.abs(z) < ANOMALY_Z) {
		return [];
	}
	const direction: 'drop' | 'spike' = z < 0 ? 'drop' : 'spike';

	const diagnosis = await diagnose(env, f, candidate.bucket, baseline.length, direction);

	const summary = buildSummary(direction, value, mean, z, diagnosis);

	return [
		{
			metric: 'pageviews',
			bucket: candidate.bucket,
			value,
			baseline_mean: mean,
			z,
			direction,
			diagnosis,
			summary,
		},
	];
}

/** Find the (dimension, value) that most drove the deviation in the anomalous hour. */
async function diagnose(
	env: Env,
	f: StatsFilter,
	bucket: number,
	baselineBuckets: number,
	direction: 'drop' | 'spike',
): Promise<Anomaly['diagnosis']> {
	const currentWindow: StatsFilter = {
		...f,
		start: bucket,
		end: bucket + HOUR_MS,
	};
	const baselineWindow: StatsFilter = { ...f, start: f.start, end: bucket };

	let best: NonNullable<Anomaly['diagnosis']> | null = null;
	let bestDelta = 0;

	for (const { dimension, column } of DIMENSIONS) {
		const [current, baseline] = await Promise.all([
			dimensionCounts(env, currentWindow, column),
			dimensionCounts(env, baselineWindow, column),
		]);
		const values = new Set<string>([...current.keys(), ...baseline.keys()]);
		for (const value of values) {
			const cur = current.get(value) ?? 0;
			const baselineAvg = (baseline.get(value) ?? 0) / baselineBuckets;
			const delta = cur - baselineAvg;
			// A drop needs current well below its baseline (negative delta); a spike, above it.
			if (direction === 'drop' ? delta >= 0 : delta <= 0) {
				continue;
			}
			if (Math.abs(delta) > bestDelta) {
				bestDelta = Math.abs(delta);
				best = {
					dimension,
					value,
					current: cur,
					baseline_avg: baselineAvg,
				};
			}
		}
	}
	return best;
}

/** Deterministic plain-language autopsy for the anomaly. */
function buildSummary(
	direction: 'drop' | 'spike',
	value: number,
	mean: number,
	z: number,
	diagnosis: Anomaly['diagnosis'],
): string {
	const pct =
		direction === 'drop'
			? Math.round((1 - value / mean) * 100)
			: Math.round((value / mean - 1) * 100);
	const zText = z.toFixed(1);
	const verb = direction === 'drop' ? 'dropped' : 'spiked';
	let summary = `Pageviews ${verb} ${pct}% in the last hour (z=${zText}).`;
	if (diagnosis) {
		const avg = Math.round(diagnosis.baseline_avg);
		summary += ` Largest contributor: ${diagnosis.dimension}=${diagnosis.value} (${diagnosis.current} vs ~${avg} typical).`;
	}
	return summary;
}
