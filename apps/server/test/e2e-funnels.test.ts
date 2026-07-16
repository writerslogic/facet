// T061: end-to-end conversions & funnels — create a goal + a 3-step funnel (admin), seed sessions
// that complete 0/1/2/3 steps (events inserted directly with controlled created_at, then
// buildSessions), then assert /stats/conversions rate and /funnels/:id/report counts + overall_rate.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { buildSessions } from '../src/lib/sessions.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const DAY = '2026-04-01';
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

describe('e2e conversions & funnels', () => {
	it('reports conversions and funnel step counts across 0/1/2/3-step journeys', async () => {
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
		const auth = { headers: { Authorization: `Bearer ${key}` } };

		// 4 visitors completing 0, 1, 2, 3 steps of /a -> /b -> purchase(event).
		// v0: neither /a nor purchase.
		await seedEvent(site.id, 'v0', '/x', null, T0);
		// v1: /a only.
		await seedEvent(site.id, 'v1', '/a', null, T0 + 10 * MIN);
		// v2: /a, /b.
		await seedEvent(site.id, 'v2', '/a', null, T0 + 20 * MIN);
		await seedEvent(site.id, 'v2', '/b', null, T0 + 21 * MIN);
		// v3: /a, /b, purchase.
		await seedEvent(site.id, 'v3', '/a', null, T0 + 30 * MIN);
		await seedEvent(site.id, 'v3', '/b', null, T0 + 31 * MIN);
		await seedEvent(site.id, 'v3', '/pay', 'purchase', T0 + 32 * MIN);

		await buildSessions(env, DAY);

		const goalRes = await app.request(
			'/api/goals',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({
					site_id: site.id,
					name: 'Purchase',
					type: 'event',
					match_value: 'purchase',
				}),
			},
			env,
		);
		const { goal } = (await goalRes.json()) as { goal: { id: string } };

		const funnelRes = await app.request(
			'/api/funnels',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({
					site_id: site.id,
					name: 'Checkout',
					steps: [
						{ type: 'path', match_value: '/a' },
						{ type: 'path', match_value: '/b' },
						{ type: 'event', match_value: 'purchase' },
					],
				}),
			},
			env,
		);
		const { funnel } = (await funnelRes.json()) as { funnel: { id: string } };

		const range = `start=${T0}&end=${T0 + 24 * H}`;

		const convRes = await app.request(
			`/api/stats/conversions?site_id=${site.id}&goal_id=${goal.id}&${range}`,
			auth,
			env,
		);
		expect(convRes.status).toBe(200);
		const conv = (await convRes.json()) as {
			conversions: number;
			sessions: number;
			rate: number;
		};
		// 4 sessions, only v3 fires purchase.
		expect(conv.sessions).toBe(4);
		expect(conv.conversions).toBe(1);
		expect(conv.rate).toBe(1 / 4);

		const repRes = await app.request(
			`/api/funnels/${funnel.id}/report?site_id=${site.id}&${range}`,
			auth,
			env,
		);
		expect(repRes.status).toBe(200);
		const rep = (await repRes.json()) as {
			steps: { index: number; match_value: string; count: number }[];
			overall_rate: number;
		};
		// step0 (/a): v1,v2,v3 -> 3. step1 (/b): v2,v3 -> 2. step2 (purchase): v3 -> 1.
		expect(rep.steps).toEqual([
			{ index: 0, match_value: '/a', count: 3 },
			{ index: 1, match_value: '/b', count: 2 },
			{ index: 2, match_value: 'purchase', count: 1 },
		]);
		expect(rep.overall_rate).toBe(1 / 3);
	});
});
