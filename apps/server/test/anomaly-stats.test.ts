// Anomaly detection over the hourly pageview series. Only fully-completed hours are analyzed: the
// in-progress hour (bucket + HOUR not yet elapsed as of `now`) is excluded from candidate and
// baseline, so partial current-hour data can't fabricate a "drop". A flat baseline followed by a
// sharp completed-hour drop is flagged with a device/country root cause.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { detectAnomalies } from '../src/db/anomaly.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';

const SITE = '55555555-5555-4555-8555-555555555555';
const T0 = Date.parse('2026-05-01T00:00:00.000Z');
const H = 3_600_000;

async function seedPageview(
	at: number,
	opts: { device?: string; country?: string; channel?: string } = {},
): Promise<void> {
	await db(env)
		.insert(schema.events)
		.values({
			id: crypto.randomUUID(),
			siteId: SITE,
			hostname: 'anom.com',
			path: '/',
			referrer: '',
			name: null,
			props: null,
			visitorHash: crypto.randomUUID(),
			country: opts.country ?? 'US',
			device: opts.device ?? 'desktop',
			createdAt: at,
			channel: opts.channel ?? 'organic',
		});
}

/** Seed `count` pageviews evenly inside the hour starting at `bucket`. */
async function seedHour(
	bucket: number,
	count: number,
	opts: { device?: string; country?: string; channel?: string } = {},
): Promise<void> {
	for (let i = 0; i < count; i++) {
		await seedPageview(bucket + i * 60_000, opts);
	}
}

/** Seed six baseline hours (~10 pv, mild jitter → nonzero stddev) starting at `from`. */
async function seedFlatBaseline(
	from: number,
	opts: { device?: string; country?: string } = {},
): Promise<void> {
	const counts = [10, 11, 9, 10, 11, 9];
	for (let h = 0; h < 6; h++) {
		await seedHour(from + h * H, counts[h] ?? 10, opts);
	}
}

describe('detectAnomalies', () => {
	it('flags a sharp final completed-hour drop and diagnoses the concentrated segment', async () => {
		await seedFlatBaseline(T0, { device: 'mobile', country: 'CA' });
		await seedHour(T0 + 6 * H, 1, { device: 'desktop', country: 'US' });

		const anomalies = await detectAnomalies(
			env,
			{ siteId: SITE, start: T0, end: T0 + 7 * H },
			T0 + 7 * H,
		);

		expect(anomalies).toHaveLength(1);
		const a = anomalies[0];
		expect(a?.direction).toBe('drop');
		expect(a?.bucket).toBe(T0 + 6 * H);
		expect(a?.value).toBe(1);
		expect(a?.diagnosis).not.toBeNull();
		expect(['device', 'country']).toContain(a?.diagnosis?.dimension);
		expect(a?.summary).toContain('dropped');
	});

	it('ignores the in-progress hour: a near-empty current hour is NOT flagged', async () => {
		// Six completed baseline hours, then a partial current hour (T0+6H) with only 1 pageview.
		// now = 30 min into hour 6, so T0+6H is in-progress and must be excluded.
		await seedFlatBaseline(T0);
		await seedHour(T0 + 6 * H, 1);
		const now = T0 + 6 * H + 30 * 60_000;

		const anomalies = await detectAnomalies(env, { siteId: SITE, start: T0, end: now }, now);
		expect(anomalies).toEqual([]);
	});

	it('flags a real drop in the last completed hour even while a partial hour is in progress', async () => {
		// Baseline hours 0-5, a genuine drop in the completed hour 6, and a partial hour 7 that
		// should be ignored. now = 20 min into hour 7.
		await seedFlatBaseline(T0);
		await seedHour(T0 + 6 * H, 1); // completed drop
		await seedHour(T0 + 7 * H, 3); // in-progress, ignored
		const now = T0 + 7 * H + 20 * 60_000;

		const anomalies = await detectAnomalies(env, { siteId: SITE, start: T0, end: now }, now);
		expect(anomalies).toHaveLength(1);
		expect(anomalies[0]?.bucket).toBe(T0 + 6 * H);
		expect(anomalies[0]?.direction).toBe('drop');
	});

	it('handles historical ranges (end already in the past) with all hours completed', async () => {
		await seedFlatBaseline(T0);
		await seedHour(T0 + 6 * H, 1);
		// now is far in the future, so every bucket in the range is completed.
		const anomalies = await detectAnomalies(
			env,
			{ siteId: SITE, start: T0, end: T0 + 7 * H },
			T0 + 100 * H,
		);
		expect(anomalies).toHaveLength(1);
		expect(anomalies[0]?.bucket).toBe(T0 + 6 * H);
	});

	it('returns [] when excluding the in-progress hour leaves too little completed history', async () => {
		await seedHour(T0, 10);
		await seedHour(T0 + H, 10);
		await seedHour(T0 + 2 * H, 0);
		// now is 30 min into hour 2 → only hours 0 and 1 are completed → baseline length 1 < min.
		const now = T0 + 2 * H + 30 * 60_000;
		const anomalies = await detectAnomalies(env, { siteId: SITE, start: T0, end: now }, now);
		expect(anomalies).toEqual([]);
	});

	it('treats the hour boundary as inclusive: a bucket is complete exactly at bucket + HOUR', async () => {
		await seedFlatBaseline(T0);
		await seedHour(T0 + 6 * H, 1);
		const bucketEnd = T0 + 7 * H; // exact end of the anomalous hour

		// now exactly at the boundary → hour 6 IS complete → flagged.
		expect(
			await detectAnomalies(env, { siteId: SITE, start: T0, end: bucketEnd }, bucketEnd),
		).toHaveLength(1);

		// now 1 ms before the boundary → hour 6 is still in progress → excluded, no anomaly.
		expect(
			await detectAnomalies(env, { siteId: SITE, start: T0, end: bucketEnd }, bucketEnd - 1),
		).toEqual([]);
	});

	it('returns [] when the final completed hour does not deviate from the baseline', async () => {
		const counts = [10, 11, 9, 10, 11, 9, 10];
		for (let h = 0; h < 7; h++) {
			await seedHour(T0 + h * H, counts[h] ?? 10);
		}
		const anomalies = await detectAnomalies(
			env,
			{ siteId: SITE, start: T0, end: T0 + 7 * H },
			T0 + 7 * H,
		);
		expect(anomalies).toEqual([]);
	});
});
