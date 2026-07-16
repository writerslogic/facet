// GET /api/stats/anomalies: returns the detected anomaly for the owning key, 403s a wrong-site key,
// and 400s an inverted range.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const H = 3_600_000;

async function setup(): Promise<{ siteId: string; key: string }> {
	const siteRes = await app.request(
		'/api/sites',
		{
			method: 'POST',
			headers: { Authorization: ADMIN, 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Acme', domain: 'acme.com' }),
		},
		env,
	);
	const { site } = (await siteRes.json()) as { site: { id: string } };
	const keyRes = await app.request(
		'/api/keys',
		{
			method: 'POST',
			headers: { Authorization: ADMIN, 'content-type': 'application/json' },
			body: JSON.stringify({ site_id: site.id }),
		},
		env,
	);
	const { key } = (await keyRes.json()) as { key: string };
	return { siteId: site.id, key };
}

async function seedHour(siteId: string, bucket: number, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await db(env)
			.insert(schema.events)
			.values({
				id: crypto.randomUUID(),
				siteId,
				hostname: 'acme.com',
				path: '/',
				referrer: '',
				name: null,
				props: null,
				visitorHash: crypto.randomUUID(),
				country: 'US',
				device: 'desktop',
				createdAt: bucket + i * 60_000,
				channel: 'organic',
			});
	}
}

describe('GET /api/stats/anomalies', () => {
	it('returns the detected anomaly for the owning key', async () => {
		const { siteId, key } = await setup();
		const baseline = [10, 11, 9, 10, 11, 9];
		for (let h = 0; h < 6; h++) {
			await seedHour(siteId, T0 + h * H, baseline[h] ?? 10);
		}
		await seedHour(siteId, T0 + 6 * H, 0);

		const res = await app.request(
			`/api/stats/anomalies?site_id=${siteId}&start=${T0}&end=${T0 + 7 * H}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(res.status).toBe(200);
		const { anomalies } = (await res.json()) as {
			anomalies: { direction: string; summary: string }[];
		};
		expect(anomalies).toHaveLength(1);
		expect(anomalies[0]?.direction).toBe('drop');
		expect(anomalies[0]?.summary).toContain('dropped');
	});

	it('rejects a wrong-site key with 403', async () => {
		const { key } = await setup();
		const other = await setup();
		const res = await app.request(
			`/api/stats/anomalies?site_id=${other.siteId}&start=${T0}&end=${T0 + 7 * H}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(res.status).toBe(403);
	});

	it('rejects an inverted range with 400', async () => {
		const { siteId, key } = await setup();
		const res = await app.request(
			`/api/stats/anomalies?site_id=${siteId}&start=${T0 + 7 * H}&end=${T0}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(res.status).toBe(400);
	});
});
