// Stats helpers over a fixed seeded set: exact aggregates, hostname filtering, zero-fill.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import {
	series,
	summary,
	topCountries,
	topDevices,
	topEvents,
	topPaths,
	topReferrers,
} from '../src/db/stats.js';

const S = '11111111-1111-4111-8111-111111111111';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const H = 3_600_000;

function mk(
	hostname: string,
	path: string,
	device: string,
	country: string,
	name: string | null,
	visitor: string,
	hour: number,
	referrer = '',
): NewEvent {
	return {
		siteId: S,
		hostname,
		path,
		referrer,
		name,
		props: null,
		visitorHash: visitor,
		country,
		device,
		createdAt: T0 + hour * H,
	};
}

const A = 'a.example.com';
const B = 'b.example.com';
const ROWS: NewEvent[] = [
	mk(A, '/', 'desktop', 'US', null, 'v1', 0),
	mk(A, '/', 'desktop', 'US', null, 'v1', 0),
	mk(A, '/pricing', 'mobile', 'US', null, 'v2', 0, 'https://google.com'),
	mk(A, '/pricing', 'mobile', 'GB', null, 'v3', 1, 'https://google.com'),
	mk(A, '/about', 'desktop', 'GB', null, 'v2', 1),
	mk(A, '/', 'desktop', 'US', 'signup', 'v1', 1),
	mk(B, '/', 'desktop', 'US', null, 'v4', 0),
	mk(B, '/contact', 'mobile', 'GB', null, 'v5', 3),
];

const fA = { siteId: S, hostname: A, start: T0, end: T0 + 4 * H };
const fAll = { siteId: S, start: T0, end: T0 + 4 * H };

beforeEach(async () => {
	for (const row of ROWS) {
		await insertEvent(env, row);
	}
});

describe('stats helpers', () => {
	it('summary counts pageviews, events, and distinct visitors', async () => {
		expect(await summary(env, fA)).toEqual({
			pageviews: 5,
			events: 1,
			visitors: 3,
		});
	});

	it('the hostname filter changes the result', async () => {
		expect((await summary(env, fAll)).pageviews).toBe(7);
		expect((await summary(env, fA)).pageviews).toBe(5);
	});

	it('topPaths / topReferrers / topEvents rank by count', async () => {
		expect(await topPaths(env, fA)).toEqual([
			{ key: '/', count: 3 },
			{ key: '/pricing', count: 2 },
			{ key: '/about', count: 1 },
		]);
		expect(await topReferrers(env, fA)).toEqual([{ key: 'https://google.com', count: 2 }]);
		expect(await topEvents(env, fA)).toEqual([{ key: 'signup', count: 1 }]);
	});

	it('topCountries and topDevices exclude nulls and rank by count', async () => {
		expect(await topCountries(env, fA)).toEqual([
			{ key: 'US', count: 4 },
			{ key: 'GB', count: 2 },
		]);
		expect(await topDevices(env, fA)).toEqual([
			{ key: 'desktop', count: 4 },
			{ key: 'mobile', count: 2 },
		]);
	});

	it('series buckets by hour and zero-fills gap buckets', async () => {
		expect(await series(env, fA, 'hour')).toEqual([
			{ t: T0, pageviews: 3, visitors: 2 },
			{ t: T0 + H, pageviews: 2, visitors: 3 },
			{ t: T0 + 2 * H, pageviews: 0, visitors: 0 },
			{ t: T0 + 3 * H, pageviews: 0, visitors: 0 },
		]);
	});
});
