// C.15: realtime snapshot — distinct active visitors + pageviews over the trailing window, from raw
// events. Privacy-safe (daily hash, no ids). Site-scoped and windowed.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { realtime } from '../src/db/stats.js';
import { issueKey } from '../src/lib/apikeys.js';

const SITE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0, 0);
const WINDOW = 300_000;

function mk(visitor: string, createdAt: number, name: string | null = null): NewEvent {
	return {
		siteId: SITE,
		hostname: 'x.example.com',
		path: '/',
		referrer: '',
		name,
		props: null,
		visitorHash: visitor,
		country: 'US',
		device: 'desktop',
		createdAt,
	};
}

describe('realtime', () => {
	it('counts distinct visitors and pageviews inside the window, excluding older events', async () => {
		await insertEvent(env, mk('a', NOW - 60_000)); // in window
		await insertEvent(env, mk('a', NOW - 30_000)); // same visitor, in window
		await insertEvent(env, mk('b', NOW - 10_000)); // distinct visitor, in window
		await insertEvent(env, mk('c', NOW - WINDOW - 1)); // just outside the window

		const snap = await realtime(env, SITE, NOW, WINDOW);
		expect(snap.window_ms).toBe(WINDOW);
		expect(snap.until).toBe(NOW);
		expect(snap.visitors).toBe(2);
		expect(snap.pageviews).toBe(3);
	});

	it('is empty when there is no recent activity', async () => {
		const snap = await realtime(env, SITE, NOW, WINDOW);
		expect(snap).toEqual({
			window_ms: WINDOW,
			visitors: 0,
			pageviews: 0,
			until: NOW,
		});
	});
});

describe('GET /api/stats/realtime', () => {
	it('returns the snapshot for the authed site and rejects a cross-site key', async () => {
		const key = (await issueKey(env, SITE, null, Date.now())).key;
		const ok = await createApp().request(
			`/api/stats/realtime?site_id=${SITE}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as {
			window_ms: number;
			visitors: number;
		};
		expect(body.window_ms).toBe(WINDOW);

		const cross = await createApp().request(
			`/api/stats/realtime?site_id=${OTHER}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(cross.status).toBe(403);
	});
});
