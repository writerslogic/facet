// Anomaly detection over the hourly pageview series: a flat baseline followed by a sharp final-hour
// drop is flagged with a device/country root cause; a flat series is quiet; too few baseline hours
// return nothing.

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

describe('detectAnomalies', () => {
	it('flags a sharp final-hour drop and diagnoses the concentrated segment', async () => {
		// 6 baseline hours around ~10 pageviews each (slight jitter → nonzero stddev),
		// concentrated on mobile/CA.
		const baseline = [10, 11, 9, 10, 11, 9];
		for (let h = 0; h < 6; h++) {
			await seedHour(T0 + h * H, baseline[h] ?? 10, {
				device: 'mobile',
				country: 'CA',
			});
		}
		// Final hour: near-zero (1 pageview), on a different segment.
		await seedHour(T0 + 6 * H, 1, { device: 'desktop', country: 'US' });

		const anomalies = await detectAnomalies(env, {
			siteId: SITE,
			start: T0,
			end: T0 + 7 * H,
		});

		expect(anomalies).toHaveLength(1);
		const a = anomalies[0];
		expect(a?.metric).toBe('pageviews');
		expect(a?.direction).toBe('drop');
		expect(a?.bucket).toBe(T0 + 6 * H);
		expect(a?.value).toBe(1);
		// The dropped segment is mobile/CA (baseline ~10, current 0).
		expect(a?.diagnosis).not.toBeNull();
		expect(['device', 'country']).toContain(a?.diagnosis?.dimension);
		if (a?.diagnosis?.dimension === 'device') {
			expect(a.diagnosis.value).toBe('mobile');
		} else {
			expect(a?.diagnosis?.value).toBe('CA');
		}
		expect(a?.summary).toContain('dropped');
	});

	it('returns [] when the final hour does not deviate from the baseline', async () => {
		// Baseline with mild variation; the final hour sits within the normal range.
		const counts = [10, 11, 9, 10, 11, 9, 10];
		for (let h = 0; h < 7; h++) {
			await seedHour(T0 + h * H, counts[h] ?? 10);
		}
		const anomalies = await detectAnomalies(env, {
			siteId: SITE,
			start: T0,
			end: T0 + 7 * H,
		});
		expect(anomalies).toEqual([]);
	});

	it('returns [] when there are fewer than the minimum baseline buckets', async () => {
		// Only 2 baseline hours + 1 candidate = baseline length 2 < ANOMALY_MIN_BASELINE.
		await seedHour(T0, 10);
		await seedHour(T0 + H, 10);
		await seedHour(T0 + 2 * H, 0);
		const anomalies = await detectAnomalies(env, {
			siteId: SITE,
			start: T0,
			end: T0 + 3 * H,
		});
		expect(anomalies).toEqual([]);
	});
});
