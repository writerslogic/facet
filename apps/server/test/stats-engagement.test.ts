// T050: GET /stats/sessions + /stats/channels and the extended /stats — authed reads over seeded
// event_sessions; site-scope enforcement.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { issueKey } from '../src/lib/apikeys.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const SITE2 = '22222222-2222-4222-8222-222222222222';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const DAY = '2026-01-01';
const H = 3_600_000;

let apiKey: string;

interface Seed {
	startedAt: number;
	pageviews: number;
	durationMs: number;
	isBounce: number;
	channel: string | null;
}

const SEEDS: Seed[] = [
	{
		startedAt: T0,
		pageviews: 1,
		durationMs: 0,
		isBounce: 1,
		channel: 'direct',
	},
	{
		startedAt: T0 + H,
		pageviews: 3,
		durationMs: 60_000,
		isBounce: 0,
		channel: 'organic',
	},
	{
		startedAt: T0 + 2 * H,
		pageviews: 2,
		durationMs: 40_000,
		isBounce: 0,
		channel: 'organic',
	},
	{
		startedAt: T0 + 3 * H,
		pageviews: 1,
		durationMs: 0,
		isBounce: 1,
		channel: 'internal',
	},
];

function get(path: string, qs: string, key: string | null) {
	return createApp().request(
		`${path}?${qs}`,
		key ? { headers: { Authorization: `Bearer ${key}` } } : {},
		env,
	);
}

const RANGE = `site_id=${SITE}&start=${T0}&end=${T0 + 24 * H}`;

const EXPECTED_ENGAGEMENT = {
	sessions: 4,
	bounce_rate: 2 / 4,
	pages_per_session: 7 / 4,
	avg_duration_ms: 100_000 / 4,
};
const EXPECTED_CHANNELS = [
	{ key: 'organic', count: 2 },
	{ key: 'direct', count: 1 },
];

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM event_sessions').run();
	const issued = await issueKey(env, SITE, null, Date.now());
	apiKey = issued.key;
	for (let i = 0; i < SEEDS.length; i++) {
		const s = SEEDS[i];
		if (!s) {
			continue;
		}
		await db(env)
			.insert(schema.eventSessions)
			.values({
				id: `sess-${i}`,
				siteId: SITE,
				visitorHash: `v${i}`,
				dayKey: DAY,
				startedAt: s.startedAt,
				endedAt: s.startedAt + s.durationMs,
				entryPath: '/',
				exitPath: '/',
				channel: s.channel,
				pageviews: s.pageviews,
				events: 0,
				durationMs: s.durationMs,
				isBounce: s.isBounce,
			});
	}
});

describe('GET /stats/sessions', () => {
	it('returns engagement for the authed site', async () => {
		const res = await get('/api/stats/sessions', RANGE, apiKey);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ engagement: EXPECTED_ENGAGEMENT });
	});

	it('rejects a mismatched site with 403', async () => {
		const res = await get(
			'/api/stats/sessions',
			`site_id=${SITE2}&start=${T0}&end=${T0 + H}`,
			apiKey,
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'site_mismatch' });
	});
});

describe('GET /stats/channels', () => {
	it('returns channels for the authed site', async () => {
		const res = await get('/api/stats/channels', RANGE, apiKey);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ channels: EXPECTED_CHANNELS });
	});

	it('rejects a mismatched site with 403', async () => {
		const res = await get(
			'/api/stats/channels',
			`site_id=${SITE2}&start=${T0}&end=${T0 + H}`,
			apiKey,
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'site_mismatch' });
	});
});

describe('GET /stats includes engagement and channels', () => {
	it('embeds both in the assembled response', async () => {
		const res = await get('/api/stats', RANGE, apiKey);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			engagement: typeof EXPECTED_ENGAGEMENT;
			channels: { key: string; count: number }[];
		};
		expect(body.engagement).toEqual(EXPECTED_ENGAGEMENT);
		expect(body.channels).toEqual(EXPECTED_CHANNELS);
	});
});
