// T048: sessionization — consecutive events per visitor split into sessions on a >30-min gap;
// bounce detection; deterministic idempotent upsert.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { buildSessions } from '../src/lib/sessions.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const DAY = '2026-01-01';
const T0 = Date.parse(`${DAY}T00:00:00.000Z`);
const MIN = 60_000;

async function ev(opts: {
	visitor: string;
	path: string;
	name: string | null;
	channel: string | null;
	at: number;
}): Promise<void> {
	await db(env).insert(schema.events).values({
		id: crypto.randomUUID(),
		siteId: SITE,
		hostname: 'x.example.com',
		path: opts.path,
		referrer: '',
		name: opts.name,
		props: null,
		visitorHash: opts.visitor,
		country: 'US',
		device: 'desktop',
		createdAt: opts.at,
		channel: opts.channel,
	});
}

async function sessionRows() {
	return db(env).select().from(schema.eventSessions).orderBy(schema.eventSessions.startedAt);
}

describe('buildSessions', () => {
	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM events').run();
		await env.DB.prepare('DELETE FROM event_sessions').run();
	});

	it('splits a visitor into two sessions across a >30-min gap', async () => {
		await ev({
			visitor: 'v1',
			path: '/',
			name: null,
			channel: 'direct',
			at: T0,
		});
		await ev({
			visitor: 'v1',
			path: '/next',
			name: null,
			channel: 'direct',
			at: T0 + 40 * MIN,
		});

		const written = await buildSessions(env, DAY);
		expect(written).toBe(2);

		const rows = await sessionRows();
		expect(rows.length).toBe(2);
		expect(rows[0]?.startedAt).toBe(T0);
		expect(rows[0]?.entryPath).toBe('/');
		expect(rows[1]?.startedAt).toBe(T0 + 40 * MIN);
		expect(rows[1]?.entryPath).toBe('/next');
	});

	it('marks a single-pageview session as a bounce', async () => {
		await ev({
			visitor: 'v2',
			path: '/',
			name: null,
			channel: 'direct',
			at: T0,
		});

		await buildSessions(env, DAY);
		const rows = await sessionRows();
		expect(rows.length).toBe(1);
		expect(rows[0]?.isBounce).toBe(1);
		expect(rows[0]?.pageviews).toBe(1);
		expect(rows[0]?.durationMs).toBe(0);
	});

	it('computes multi-event sessions and channel/exit from the group', async () => {
		await ev({
			visitor: 'v3',
			path: '/',
			name: null,
			channel: 'organic',
			at: T0,
		});
		await ev({
			visitor: 'v3',
			path: '/a',
			name: null,
			channel: 'referral',
			at: T0 + 5 * MIN,
		});
		await ev({
			visitor: 'v3',
			path: '/a',
			name: 'signup',
			channel: 'direct',
			at: T0 + 6 * MIN,
		});

		await buildSessions(env, DAY);
		const rows = await sessionRows();
		expect(rows.length).toBe(1);
		const s = rows[0];
		expect(s?.pageviews).toBe(2);
		expect(s?.events).toBe(1);
		expect(s?.entryPath).toBe('/');
		expect(s?.exitPath).toBe('/a');
		expect(s?.channel).toBe('organic');
		expect(s?.isBounce).toBe(0);
		expect(s?.durationMs).toBe(6 * MIN);
	});

	it('is idempotent — re-running yields identical rows', async () => {
		await ev({
			visitor: 'v1',
			path: '/',
			name: null,
			channel: 'direct',
			at: T0,
		});
		await ev({
			visitor: 'v1',
			path: '/next',
			name: null,
			channel: 'direct',
			at: T0 + 40 * MIN,
		});

		await buildSessions(env, DAY);
		const first = await sessionRows();
		await buildSessions(env, DAY);
		const second = await sessionRows();

		expect(second.length).toBe(first.length);
		expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
		expect(second).toEqual(first);
	});
});
