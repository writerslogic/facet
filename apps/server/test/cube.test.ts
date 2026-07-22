// The dimensional cube: per-(bucket, device, country, channel) counts. The load-bearing properties are
// that pageviews/events are ADDITIVE across cells (so the client can sum them under any filter and match
// the server total) while visitors is COUNT(DISTINCT) per cell and is NOT additive (summing over-counts
// a visitor who spans cells). Both are asserted against a fixed seed.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { cube, summary } from '../src/db/stats.js';

const S = '11111111-1111-4111-8111-111111111111';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const H = 3_600_000;

function mk(
	device: string,
	country: string,
	name: string | null,
	visitor: string,
	hour: number,
): NewEvent {
	return {
		siteId: S,
		hostname: 'a.example.com',
		path: '/',
		referrer: '',
		name,
		props: null,
		visitorHash: visitor,
		country,
		device,
		createdAt: T0 + hour * H,
	};
}

// v2 appears in two distinct cells (US/mobile@T0 and GB/desktop@T0+H); v1 also spans two cells.
const ROWS: NewEvent[] = [
	mk('desktop', 'US', null, 'v1', 0),
	mk('desktop', 'US', null, 'v1', 0),
	mk('mobile', 'US', null, 'v2', 0),
	mk('mobile', 'GB', null, 'v3', 1),
	mk('desktop', 'GB', null, 'v2', 1),
	mk('desktop', 'US', 'signup', 'v1', 1),
];

const f = { siteId: S, start: T0, end: T0 + 4 * H };

beforeEach(async () => {
	for (const row of ROWS) await insertEvent(env, row);
});

describe('dimensional cube', () => {
	it('pageviews and events are additive across cells (sum matches the server total)', async () => {
		const cells = await cube(env, f, 'hour');
		const total = await summary(env, f);
		const sumPv = cells.reduce((a, c) => a + c.pageviews, 0);
		const sumEv = cells.reduce((a, c) => a + c.events, 0);
		expect(sumPv).toBe(total.pageviews);
		expect(sumEv).toBe(total.events);
	});

	it('visitors is per-cell distinct and NOT additive (summing over-counts cross-cell visitors)', async () => {
		const cells = await cube(env, f, 'hour');
		const total = await summary(env, f);
		const sumVisitors = cells.reduce((a, c) => a + c.visitors, 0);
		// v1 and v2 each appear in two cells, so the naive sum exceeds the true distinct count.
		expect(total.visitors).toBe(3);
		expect(sumVisitors).toBeGreaterThan(total.visitors);
	});

	it('carries the low-cardinality dimensions and folds an unset channel to "unknown"', async () => {
		const cells = await cube(env, f, 'hour');
		const usDesktopT0 = cells.find(
			(c) => c.t === T0 && c.device === 'desktop' && c.country === 'US',
		);
		expect(usDesktopT0).toMatchObject({
			channel: 'unknown',
			pageviews: 2,
			visitors: 1,
		});
		// Every cell names all three axes (never null/undefined).
		expect(cells.every((c) => c.device && c.country && c.channel)).toBe(true);
	});
});
