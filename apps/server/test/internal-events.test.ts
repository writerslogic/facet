// A.4: internal/system events ($-prefixed like $exposure, and the auto form_submit) are excluded
// from marketer-facing custom-event metrics (summary.events, topEvents) but remain queryable via
// topInteractions.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { summary, topEvents, topInteractions } from '../src/db/stats.js';

const SITE = '77777777-7777-4777-8777-777777777777';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

function mk(name: string | null, i: number): NewEvent {
	return {
		siteId: SITE,
		hostname: 'x.example.com',
		path: '/',
		referrer: '',
		name,
		props: null,
		visitorHash: `v${i}`,
		country: 'US',
		device: 'desktop',
		createdAt: T0 + i * 1000,
	};
}

const F = { siteId: SITE, start: T0, end: T0 + 60_000 };

beforeEach(async () => {
	for (const row of [
		mk(null, 0), // pageview
		mk(null, 1), // pageview
		mk('signup', 2), // custom event
		mk('signup', 3), // custom event
		mk('$exposure', 4), // internal (experiment)
		mk('form_submit', 5), // internal (auto interaction)
	]) {
		await insertEvent(env, row);
	}
});

describe('internal event filtering', () => {
	it('excludes internal events from the custom-events count', async () => {
		expect((await summary(env, F)).events).toBe(2);
	});

	it('excludes internal events from Top Events', async () => {
		const rows = await topEvents(env, F);
		expect(rows).toEqual([{ key: 'signup', count: 2 }]);
		expect(rows.some((r) => r.key.startsWith('$'))).toBe(false);
		expect(rows.some((r) => r.key === 'form_submit')).toBe(false);
	});

	it('surfaces internal events via topInteractions', async () => {
		const rows = await topInteractions(env, F);
		const keys = rows.map((r) => r.key);
		expect(keys).toContain('$exposure');
		expect(keys).toContain('form_submit');
		expect(keys).not.toContain('signup');
	});
});
