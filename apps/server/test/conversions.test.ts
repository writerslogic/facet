// Goal conversions over the authed /api/stats/conversions endpoint, for event-type and path-type goals.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { buildSessions } from '../src/lib/sessions.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const DAY = '2026-02-01';
const T0 = Date.parse(`${DAY}T00:00:00.000Z`);
const H = 3_600_000;
const MIN = 60_000;

async function seedEvent(
	siteId: string,
	visitor: string,
	path: string,
	name: string | null,
	at: number,
): Promise<void> {
	await db(env).insert(schema.events).values({
		id: crypto.randomUUID(),
		siteId,
		hostname: 'acme.com',
		path,
		referrer: '',
		name,
		props: null,
		visitorHash: visitor,
		country: 'US',
		device: 'desktop',
		createdAt: at,
		channel: 'organic',
	});
}

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

async function createGoal(
	siteId: string,
	type: 'event' | 'path',
	matchValue: string,
): Promise<string> {
	const res = await app.request(
		'/api/goals',
		{
			method: 'POST',
			headers: { Authorization: ADMIN, 'content-type': 'application/json' },
			body: JSON.stringify({
				site_id: siteId,
				name: 'g',
				type,
				match_value: matchValue,
			}),
		},
		env,
	);
	const { goal } = (await res.json()) as { goal: { id: string } };
	return goal.id;
}

describe('goal conversions', () => {
	it('counts sessions that fire the goal event, computing the rate', async () => {
		const { siteId, key } = await setup();
		// visitor A converts (fires signup), visitor B does not.
		await seedEvent(siteId, 'conv-a', '/', null, T0);
		await seedEvent(siteId, 'conv-a', '/pricing', 'signup', T0 + 5 * MIN);
		await seedEvent(siteId, 'conv-b', '/', null, T0 + 10 * MIN);
		await buildSessions(env, DAY);

		const goalId = await createGoal(siteId, 'event', 'signup');
		const qs = `site_id=${siteId}&goal_id=${goalId}&start=${T0}&end=${T0 + 24 * H}`;
		const res = await app.request(
			`/api/stats/conversions?${qs}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			goal_id: string;
			conversions: number;
			sessions: number;
			rate: number;
		};
		expect(body.goal_id).toBe(goalId);
		expect(body.sessions).toBe(2);
		expect(body.conversions).toBe(1);
		expect(body.rate).toBe(1 / 2);
	});

	it('matches a path-type goal on the visited path', async () => {
		const { siteId, key } = await setup();
		await seedEvent(siteId, 'path-a', '/', null, T0);
		await seedEvent(siteId, 'path-a', '/thanks', null, T0 + 2 * MIN);
		await seedEvent(siteId, 'path-b', '/', null, T0 + 10 * MIN);
		await buildSessions(env, DAY);

		const goalId = await createGoal(siteId, 'path', '/thanks');
		const qs = `site_id=${siteId}&goal_id=${goalId}&start=${T0}&end=${T0 + 24 * H}`;
		const res = await app.request(
			`/api/stats/conversions?${qs}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			conversions: number;
			sessions: number;
			rate: number;
		};
		expect(body.sessions).toBe(2);
		expect(body.conversions).toBe(1);
		expect(body.rate).toBe(1 / 2);
	});
});
