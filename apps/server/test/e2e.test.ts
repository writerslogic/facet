// End-to-end acceptance for the ingest → D1 → scheduled rollup → stats → asset path. Ingests
// client-shaped beacons across two hostnames (a bot dropped), runs the scheduled handler, and
// asserts exact stats, the per-hostname split, and that the dashboard is served.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { HOUR_MS } from '../src/lib/constants.js';
import { runScheduled } from '../src/lib/scheduled.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const CHROME =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
const HOST_A = 'a.example.com';
const HOST_B = 'b.example.com';

interface Beacon {
	ip: string;
	ua: string;
	hostname: string;
	path: string;
	name?: string;
}

function collect(siteId: string, b: Beacon) {
	const body: Record<string, unknown> = {
		site_id: siteId,
		hostname: b.hostname,
		path: b.path,
		referrer: '',
	};
	if (b.name) {
		body.name = b.name;
	}
	return app.request(
		'/api/collect',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'CF-Connecting-IP': b.ip,
				'user-agent': b.ua,
			},
			body: JSON.stringify(body),
		},
		env,
	);
}

interface Summary {
	pageviews: number;
	events: number;
	visitors: number;
}

async function stats(
	siteId: string,
	key: string,
	hostname?: string,
): Promise<{
	summary: Summary;
	top_paths: { key: string; count: number }[];
	top_events: { key: string; count: number }[];
}> {
	const now = Date.now();
	const qs = new URLSearchParams({
		site_id: siteId,
		start: String(now - HOUR_MS),
		end: String(now + HOUR_MS),
	});
	if (hostname) {
		qs.set('hostname', hostname);
	}
	const res = await app.request(
		`/api/stats?${qs}`,
		{ headers: { Authorization: `Bearer ${key}` } },
		env,
	);
	expect(res.status).toBe(200);
	return res.json();
}

describe('end-to-end acceptance', () => {
	it('ingests, aggregates, and reports exact per-site and per-hostname stats', async () => {
		// 1. Create a site and issue a key (admin).
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

		// 2. Ingest: visitor X (2 pageviews + 1 signup on host A), visitor Y (1 pageview on host B),
		//    and a bot that must be dropped.
		const X = { ip: '203.0.113.10', ua: CHROME };
		const Y = { ip: '203.0.113.20', ua: FIREFOX };
		for (const b of [
			{ ...X, hostname: HOST_A, path: '/' },
			{ ...X, hostname: HOST_A, path: '/pricing' },
			{ ...X, hostname: HOST_A, path: '/', name: 'signup' },
			{ ...Y, hostname: HOST_B, path: '/' },
		]) {
			expect((await collect(site.id, b)).status).toBe(202);
		}
		expect(
			(
				await collect(site.id, {
					ip: '203.0.113.99',
					ua: 'Googlebot/2.1',
					hostname: HOST_A,
					path: '/',
				})
			).status,
		).toBe(202);

		// 3. Run the scheduled handler (rollups + retention). Fresh data must survive.
		const controller = {
			scheduledTime: Date.now(),
			cron: '0 * * * *',
			noRetry() {},
		} as unknown as ScheduledController;
		await expect(runScheduled(controller, env)).resolves.toBeUndefined();

		// 4a. Site-wide stats (bot excluded).
		const all = await stats(site.id, key);
		expect(all.summary).toEqual({ pageviews: 3, events: 1, visitors: 2 });
		expect(all.top_paths).toContainEqual({ key: '/', count: 3 });
		expect(all.top_paths).toContainEqual({ key: '/pricing', count: 1 });
		expect(all.top_events).toContainEqual({ key: 'signup', count: 1 });

		// 4b. Per-hostname split.
		expect((await stats(site.id, key, HOST_A)).summary).toEqual({
			pageviews: 2,
			events: 1,
			visitors: 1,
		});
		expect((await stats(site.id, key, HOST_B)).summary).toEqual({
			pageviews: 1,
			events: 0,
			visitors: 1,
		});

		// 5. The dashboard is served for a navigation request.
		const page = await app.request(
			'/',
			{ method: 'GET', headers: { accept: 'text/html' } },
			env,
		);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('<div id="root">');
	});
});
