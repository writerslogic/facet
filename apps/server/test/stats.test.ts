// GET /api/stats: authed read returns the assembled response; enforces site scope, range
// validity, and the max range.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { issueKey } from '../src/lib/apikeys.js';
import { DAY_MS, HOUR_MS } from '../src/lib/constants.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const SITE2 = '22222222-2222-4222-8222-222222222222';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

let apiKey: string;

function mk(
	path: string,
	device: string,
	country: string,
	name: string | null,
	visitor: string,
	offset: number,
): NewEvent {
	return {
		siteId: SITE,
		hostname: 'x.example.com',
		path,
		referrer: '',
		name,
		props: null,
		visitorHash: visitor,
		country,
		device,
		createdAt: T0 + offset,
	};
}

function get(qs: string, key: string | null) {
	return createApp().request(
		`/api/stats?${qs}`,
		key ? { headers: { Authorization: `Bearer ${key}` } } : {},
		env,
	);
}

beforeEach(async () => {
	const issued = await issueKey(env, SITE, null, Date.now());
	apiKey = issued.key;
	for (const row of [
		mk('/', 'desktop', 'US', null, 'v1', 0),
		mk('/', 'desktop', 'US', null, 'v1', 0),
		mk('/p', 'mobile', 'GB', null, 'v2', 1000),
		mk('/', 'desktop', 'US', 'signup', 'v1', 2000),
	]) {
		await insertEvent(env, row);
	}
});

describe('GET /api/stats', () => {
	it('returns the assembled stats for the authed site', async () => {
		const res = await get(`site_id=${SITE}&start=${T0}&end=${T0 + 2 * HOUR_MS}`, apiKey);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			summary: { pageviews: number; events: number; visitors: number };
			series: unknown[];
			top_paths: { key: string; count: number }[];
			top_countries: { key: string; count: number }[];
			top_devices: { key: string; count: number }[];
		};
		expect(body.summary).toEqual({ pageviews: 3, events: 1, visitors: 2 });
		expect(body.series.length).toBeGreaterThan(0);
		expect(body.top_paths).toContainEqual({ key: '/', count: 3 });
		expect(body.top_countries).toContainEqual({ key: 'US', count: 3 });
		expect(body.top_devices).toContainEqual({ key: 'desktop', count: 3 });
	});

	it('rejects a key scoped to a different site with 403 site_mismatch', async () => {
		const res = await get(`site_id=${SITE2}&start=${T0}&end=${T0 + HOUR_MS}`, apiKey);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'site_mismatch' });
	});

	it('rejects missing auth with 401 invalid_api_key', async () => {
		const res = await get(`site_id=${SITE}&start=${T0}&end=${T0 + HOUR_MS}`, null);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'invalid_api_key' });
	});

	it('rejects end <= start with 400 bad_range', async () => {
		const res = await get(`site_id=${SITE}&start=${T0}&end=${T0}`, apiKey);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'bad_range' });
	});

	it('rejects a range over 90 days with 400 range_too_large', async () => {
		const res = await get(`site_id=${SITE}&start=${T0}&end=${T0 + 91 * DAY_MS}`, apiKey);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'range_too_large' });
	});
});
