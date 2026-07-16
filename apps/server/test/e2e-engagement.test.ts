// T052: end-to-end engagement — a scripted visitor journey (3 pageviews within the timeout, a
// >30-min gap, then 1 more) is seeded with controlled timestamps, sessionized, and read back
// through the authed /stats/sessions + /stats/channels endpoints. Events are inserted directly
// because POST /api/collect stamps Date.now(), which can't produce a controlled session gap.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { buildSessions } from '../src/lib/sessions.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const DAY = '2026-01-01';
const T0 = Date.parse(`${DAY}T00:00:00.000Z`);
const MIN = 60_000;
const H = 3_600_000;

async function seedEvent(siteId: string, path: string, channel: string, at: number): Promise<void> {
	await db(env).insert(schema.events).values({
		id: crypto.randomUUID(),
		siteId,
		hostname: 'acme.com',
		path,
		referrer: '',
		name: null,
		props: null,
		visitorHash: 'journey-visitor',
		country: 'US',
		device: 'desktop',
		createdAt: at,
		channel,
	});
}

describe('end-to-end engagement', () => {
	it('sessionizes a scripted journey and reports it through the authed endpoints', async () => {
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

		// 3 pageviews within the timeout (organic entry), then a >30-min gap + 1 more (a bounce).
		await seedEvent(site.id, '/', 'organic', T0);
		await seedEvent(site.id, '/pricing', 'organic', T0 + 5 * MIN);
		await seedEvent(site.id, '/features', 'organic', T0 + 10 * MIN);
		await seedEvent(site.id, '/', 'organic', T0 + 45 * MIN);

		const written = await buildSessions(env, DAY);
		expect(written).toBe(2);

		const qs = `site_id=${site.id}&start=${T0}&end=${T0 + 24 * H}`;
		const auth = { headers: { Authorization: `Bearer ${key}` } };

		const sessRes = await app.request(`/api/stats/sessions?${qs}`, auth, env);
		expect(sessRes.status).toBe(200);
		const { engagement } = (await sessRes.json()) as {
			engagement: {
				sessions: number;
				bounce_rate: number;
				pages_per_session: number;
				avg_duration_ms: number;
			};
		};
		// Session A: 3 pageviews, not a bounce. Session B: 1 pageview, a bounce.
		expect(engagement.sessions).toBe(2);
		expect(engagement.bounce_rate).toBe(1 / 2);
		expect(engagement.pages_per_session).toBe(4 / 2);
		expect(engagement.avg_duration_ms).toBe((10 * MIN + 0) / 2);

		const chanRes = await app.request(`/api/stats/channels?${qs}`, auth, env);
		expect(chanRes.status).toBe(200);
		const { channels } = (await chanRes.json()) as {
			channels: { key: string; count: number }[];
		};
		expect(channels).toEqual([{ key: 'organic', count: 2 }]);
	});
});
