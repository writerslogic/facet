// T059: funnel report — seed sessions with known step completion and assert each steps[i].count and
// overall_rate; verify out-of-order events do NOT count as progression.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { buildSessions } from '../src/lib/sessions.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const DAY = '2026-03-01';
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

describe('funnel report', () => {
	it('counts sessions reaching each ordered step and computes overall_rate', async () => {
		const { siteId, key } = await setup();
		// Funnel: /a -> /b -> checkout(event)
		// v1 completes all 3; v2 reaches step 2 (/a,/b); v3 reaches step 1 (/a only).
		await seedEvent(siteId, 'v1', '/a', null, T0);
		await seedEvent(siteId, 'v1', '/b', null, T0 + 1 * MIN);
		await seedEvent(siteId, 'v1', '/pay', 'checkout', T0 + 2 * MIN);

		await seedEvent(siteId, 'v2', '/a', null, T0 + 10 * MIN);
		await seedEvent(siteId, 'v2', '/b', null, T0 + 11 * MIN);

		await seedEvent(siteId, 'v3', '/a', null, T0 + 20 * MIN);

		// v4: hits /b BEFORE /a — out of order, so it only reaches step 1 (via the later /a? no:
		// the funnel needs /a first, then /b; /a fires after /b, so it reaches step 1 only).
		await seedEvent(siteId, 'v4', '/b', null, T0 + 30 * MIN);
		await seedEvent(siteId, 'v4', '/a', null, T0 + 31 * MIN);

		await buildSessions(env, DAY);

		const funnelRes = await app.request(
			'/api/funnels',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({
					site_id: siteId,
					name: 'Checkout',
					steps: [
						{ type: 'path', match_value: '/a' },
						{ type: 'path', match_value: '/b' },
						{ type: 'event', match_value: 'checkout' },
					],
				}),
			},
			env,
		);
		const { funnel } = (await funnelRes.json()) as { funnel: { id: string } };

		const qs = `site_id=${siteId}&start=${T0}&end=${T0 + 24 * H}`;
		const res = await app.request(
			`/api/funnels/${funnel.id}/report?${qs}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			steps: { index: number; match_value: string; count: number }[];
			overall_rate: number;
		};
		// step0 (/a): v1,v2,v3,v4 -> 4. step1 (/b): v1,v2 -> 2. step2 (checkout): v1 -> 1.
		expect(body.steps).toEqual([
			{ index: 0, match_value: '/a', count: 4 },
			{ index: 1, match_value: '/b', count: 2 },
			{ index: 2, match_value: 'checkout', count: 1 },
		]);
		expect(body.overall_rate).toBe(1 / 4);
	});
});
