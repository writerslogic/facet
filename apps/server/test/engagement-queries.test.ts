// T049: engagement + channels helpers over a fixed seeded set of event_sessions — exact metrics,
// channel grouping/sorting, and `internal` exclusion.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { channels, engagement } from '../src/db/stats.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const DAY = '2026-01-01';
const H = 3_600_000;

interface Seed {
	visitor: string;
	startedAt: number;
	pageviews: number;
	events: number;
	durationMs: number;
	isBounce: number;
	channel: string | null;
}

const SEEDS: Seed[] = [
	{
		visitor: 'v1',
		startedAt: T0,
		pageviews: 1,
		events: 0,
		durationMs: 0,
		isBounce: 1,
		channel: 'direct',
	},
	{
		visitor: 'v2',
		startedAt: T0 + H,
		pageviews: 3,
		events: 1,
		durationMs: 60_000,
		isBounce: 0,
		channel: 'organic',
	},
	{
		visitor: 'v3',
		startedAt: T0 + 2 * H,
		pageviews: 2,
		events: 0,
		durationMs: 40_000,
		isBounce: 0,
		channel: 'organic',
	},
	{
		visitor: 'v4',
		startedAt: T0 + 3 * H,
		pageviews: 1,
		events: 0,
		durationMs: 0,
		isBounce: 1,
		channel: 'internal',
	},
	{
		visitor: 'v5',
		startedAt: T0 + 4 * H,
		pageviews: 4,
		events: 2,
		durationMs: 100_000,
		isBounce: 0,
		channel: null,
	},
];

const f = { siteId: SITE, start: T0, end: T0 + 24 * H };

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM event_sessions').run();
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
				visitorHash: s.visitor,
				dayKey: DAY,
				startedAt: s.startedAt,
				endedAt: s.startedAt + s.durationMs,
				entryPath: '/',
				exitPath: '/',
				channel: s.channel,
				pageviews: s.pageviews,
				events: s.events,
				durationMs: s.durationMs,
				isBounce: s.isBounce,
			});
	}
});

describe('engagement', () => {
	it('computes exact metrics over all sessions', async () => {
		// 5 sessions; bounces = 2 (v1, v4); pageviews = 1+3+2+1+4 = 11; duration = 0+60k+40k+0+100k = 200k
		expect(await engagement(env, f)).toEqual({
			sessions: 5,
			bounce_rate: 2 / 5,
			pages_per_session: 11 / 5,
			avg_duration_ms: 200_000 / 5,
		});
	});

	it('returns all-zero when there are no sessions in range', async () => {
		expect(
			await engagement(env, {
				siteId: SITE,
				start: T0 - 48 * H,
				end: T0 - 24 * H,
			}),
		).toEqual({
			sessions: 0,
			bounce_rate: 0,
			pages_per_session: 0,
			avg_duration_ms: 0,
		});
	});
});

describe('channels', () => {
	it('groups by channel, sorts count desc, and excludes internal and null', async () => {
		expect(await channels(env, f)).toEqual([
			{ key: 'organic', count: 2 },
			{ key: 'direct', count: 1 },
		]);
	});
});
