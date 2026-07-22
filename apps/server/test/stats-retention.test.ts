// GET /stats/retention: authed cohort-retention read over seeded `sessions`. Site-scope enforcement,
// range validation, period validation, and the salt-window note in the response.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { issueKey } from '../src/lib/apikeys.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const SITE2 = '22222222-2222-4222-8222-222222222222';
const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 0, 5); // a Monday

let apiKey: string;

function dayKey(offset: number): string {
	return new Date(T0 + offset * DAY_MS).toISOString().slice(0, 10);
}

function get(path: string, qs: string, key: string | null) {
	return createApp().request(
		`${path}?${qs}`,
		key ? { headers: { Authorization: `Bearer ${key}` } } : {},
		env,
	);
}

const RANGE = `site_id=${SITE}&start=${T0}&end=${T0 + 40 * DAY_MS}`;

async function seedSession(visitor: string, dayOffset: number): Promise<void> {
	await db(env)
		.insert(schema.sessions)
		.values({
			siteId: SITE,
			visitorHash: visitor,
			dayKey: dayKey(dayOffset),
			firstSeen: T0 + dayOffset * DAY_MS,
		});
}

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM sessions').run();
	await env.DB.prepare('DELETE FROM api_keys').run();
	const issued = await issueKey(env, SITE, null, Date.now());
	apiKey = issued.key;
});

describe('GET /stats/retention', () => {
	it('returns a weekly cohort triangle with a stable visitor counted as retained', async () => {
		await seedSession('stable', 0);
		await seedSession('stable', 7);
		await seedSession('other', 0);

		const res = await get('/api/stats/retention', `${RANGE}&period=week`, apiKey);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			period: string;
			cohorts: { cohort: string; size: number; retention: number[] }[];
			note: string;
		};
		expect(body.period).toBe('week');
		const wk0 = body.cohorts.find((c) => c.cohort === dayKey(0));
		expect(wk0?.size).toBe(2);
		expect(wk0?.retention).toEqual([1, 0.5]);
		expect(body.note).toMatch(/salt window/i);
	});

	it('defaults to weekly cohorts when period is omitted', async () => {
		await seedSession('v', 0);
		const res = await get('/api/stats/retention', RANGE, apiKey);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { period: string }).period).toBe('week');
	});

	it('reflects the daily-window reality (rotated hashes are new visitors, no cross-day return)', async () => {
		await seedSession('hash-d0', 0);
		await seedSession('hash-d1', 1);
		const res = await get('/api/stats/retention', `${RANGE}&period=day`, apiKey);
		const body = (await res.json()) as {
			cohorts: { size: number; retention: number[] }[];
		};
		expect(body.cohorts).toHaveLength(2);
		for (const c of body.cohorts) {
			expect(c.retention).toEqual([1]);
		}
	});

	it('rejects a mismatched site with 403', async () => {
		const res = await get(
			'/api/stats/retention',
			`site_id=${SITE2}&start=${T0}&end=${T0 + DAY_MS}`,
			apiKey,
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'site_mismatch' });
	});

	it('rejects an inverted range with 400', async () => {
		const res = await get(
			'/api/stats/retention',
			`site_id=${SITE}&start=${T0 + DAY_MS}&end=${T0}`,
			apiKey,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'bad_range' });
	});

	it('rejects an over-large range with 400', async () => {
		const res = await get(
			'/api/stats/retention',
			`site_id=${SITE}&start=${T0}&end=${T0 + 91 * DAY_MS}`,
			apiKey,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'range_too_large' });
	});

	it('rejects an unknown period with 400', async () => {
		const res = await get('/api/stats/retention', `${RANGE}&period=month`, apiKey);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'bad_request' });
	});

	it('requires an API key', async () => {
		const res = await get('/api/stats/retention', RANGE, null);
		expect(res.status).toBe(401);
	});
});
