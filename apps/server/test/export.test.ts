// F.21: GET /api/stats/export — authenticated, site-scoped CSV/JSON export of series and breakdowns
// with bounded output, header/disposition correctness, and CSV formula-injection safety.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { issueKey } from '../src/lib/apikeys.js';

const SITE = '99999999-9999-4999-8999-999999999999';
const OTHER = '11111111-1111-4111-8111-111111111111';
const T0 = Date.UTC(2026, 3, 1, 0, 0, 0, 0);
const END = T0 + 3 * 3_600_000;
let key: string;

function mk(name: string | null, path: string, i: number): NewEvent {
	return {
		siteId: SITE,
		hostname: 'x.example.com',
		path,
		referrer: '',
		name,
		props: null,
		visitorHash: `v${i}`,
		country: 'US',
		device: 'desktop',
		createdAt: T0 + i * 1000,
	};
}

function get(qs: string, apiKey: string | null) {
	return createApp().request(
		`/api/stats/export?${qs}`,
		apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {},
		env,
	);
}

beforeEach(async () => {
	key = (await issueKey(env, SITE, null, Date.now())).key;
	await insertEvent(env, mk(null, '/', 0));
	await insertEvent(env, mk(null, '/pricing', 1));
	await insertEvent(env, mk('=cmd,danger', '/', 2)); // custom event name: formula-injection + comma bait
});

describe('GET /api/stats/export', () => {
	it('rejects a missing key (401) and a cross-site key (403)', async () => {
		expect((await get(`site_id=${SITE}&start=${T0}&end=${END}`, null)).status).toBe(401);
		expect((await get(`site_id=${OTHER}&start=${T0}&end=${END}`, key)).status).toBe(403);
	});

	it('exports a CSV series with correct headers and disposition', async () => {
		const res = await get(
			`site_id=${SITE}&start=${T0}&end=${END}&kind=series&interval=hour`,
			key,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/csv');
		expect(res.headers.get('content-disposition')).toContain(
			'attachment; filename="facet-series',
		);
		const text = await res.text();
		expect(text.split('\r\n')[0]).toBe('bucket_start_iso,bucket_start_ms,pageviews,visitors');
	});

	it('exports a JSON breakdown with columns + rows', async () => {
		const res = await get(
			`site_id=${SITE}&start=${T0}&end=${END}&kind=breakdown&dimension=path&format=json`,
			key,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			columns: string[];
			rows: [string, number][];
		};
		expect(body.columns).toEqual(['key', 'count']);
		expect(body.rows).toContainEqual(['/', 2]);
		expect(body.rows).toContainEqual(['/pricing', 1]);
	});

	it('neutralizes CSV formula injection on breakdown values', async () => {
		const res = await get(
			`site_id=${SITE}&start=${T0}&end=${END}&kind=breakdown&dimension=event`,
			key,
		);
		const text = await res.text();
		// The dangerous name has a leading '=' and a comma, so it must be apostrophe-guarded AND quoted.
		expect(text).toContain(`"'=cmd,danger"`);
		expect(text).not.toContain('\r\n=cmd');
	});

	it('returns just the header for an empty range', async () => {
		const res = await get(
			`site_id=${SITE}&start=${T0 - 10 * 86_400_000}&end=${T0 - 9 * 86_400_000}&kind=breakdown&dimension=path`,
			key,
		);
		expect(await res.text()).toBe('key,count\r\n');
	});

	it('validates range, format, dimension, and limit', async () => {
		expect((await get(`site_id=${SITE}&start=${END}&end=${T0}`, key)).status).toBe(400); // bad range
		expect((await get(`site_id=${SITE}&start=${T0}&end=${END}&format=xml`, key)).status).toBe(
			400,
		);
		expect(
			(await get(`site_id=${SITE}&start=${T0}&end=${END}&kind=breakdown&dimension=nope`, key))
				.status,
		).toBe(400);
		expect(
			(
				await get(
					`site_id=${SITE}&start=${T0}&end=${END}&kind=breakdown&dimension=path&limit=99999`,
					key,
				)
			).status,
		).toBe(400);
	});
});
