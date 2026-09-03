// Narrow stats routes: each response exposes only the fields its dashboard consumer needs while the
// legacy /api/stats contract remains intact. These exercise the raw D1 batch result mapping used to
// retain rows_read telemetry, not just the underlying Drizzle helpers.

import { env } from 'cloudflare:workers';
import type {
	CubeResponse,
	RealtimeContextResponse,
	StatsAcquisitionResponse,
	StatsAttributionResponse,
	StatsContentResponse,
	StatsCoreResponse,
	StatsEngagementResponse,
	StatsFreshnessResponse,
	StatsResponse,
	StatsRevenueResponse,
	StatsSummaryResponse,
	StatsTechnologyResponse,
} from '@facet/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { coreStats, cubeStats } from '../src/db/stats.js';
import { issueKey } from '../src/lib/apikeys.js';
import { buildSessions } from '../src/lib/sessions.js';
import { seedSite } from './fixtures.js';

const DAY = '2026-08-20';
const START = Date.parse(`${DAY}T00:00:00.000Z`);
const END = START + 86_400_000;

const app = createApp();

let siteId: string;
let key: string;

function event(overrides: Partial<NewEvent> & Pick<NewEvent, 'path' | 'createdAt'>): NewEvent {
	return {
		siteId,
		hostname: 'slices.example.com',
		referrer: 'https://search.example/',
		name: null,
		props: null,
		visitorHash: 'slice-visitor',
		country: 'US',
		device: 'desktop',
		channel: 'organic',
		browser: 'Chrome',
		os: 'macOS',
		screenTier: 'desktop',
		language: 'en',
		region: 'CA',
		network: 'residential',
		connection: 'fast',
		...overrides,
	};
}

async function get<T>(path: string): Promise<T> {
	const response = await app.request(
		path,
		{
			headers: { Authorization: `Bearer ${key}` },
		},
		env,
	);
	expect(response.status).toBe(200);
	return (await response.json()) as T;
}

function query(path: string): string {
	return `${path}?site_id=${siteId}&start=${START}&end=${END}&interval=hour`;
}

beforeEach(async () => {
	({ siteId } = await seedSite(env, { hostname: 'slices.example.com' }));
	key = (await issueKey(env, siteId, null, START)).key;
	await insertEvent(env, event({ path: '/', createdAt: START + 1_000 }));
	await insertEvent(env, event({ path: '/pricing', channel: 'email', createdAt: START + 2_000 }));
	await insertEvent(
		env,
		event({
			path: '/pricing',
			name: 'purchase',
			channel: 'email',
			value: 50,
			currency: 'USD',
			createdAt: START + 3_000,
		}),
	);
	await buildSessions(env, DAY);
});

describe('narrow stats routes', () => {
	it('returns summary and series only from /stats/core', async () => {
		const body = await get<StatsCoreResponse>(query('/api/stats/core'));
		expect(Object.keys(body).sort()).toEqual(['series', 'summary']);
		expect(body.summary).toEqual({ pageviews: 2, visitors: 1, events: 1 });
		expect(body.series).toHaveLength(24);
		expect(body.series[0]).toMatchObject({ pageviews: 2, visitors: 1 });
	});

	it('retains privacy-safe D1 cost metadata outside the response body', async () => {
		const read = await coreStats(env, { siteId, start: START, end: END }, 'hour');
		expect(read.metrics.statements).toBe(2);
		expect(read.metrics.rowsRead).toBeGreaterThan(0);
		expect(read.metrics.durationMs).toBeGreaterThanOrEqual(0);
		expect(read.data).not.toHaveProperty('metrics');
	});

	it('scopes the cube to path/referrer filters and records both dependent statements', async () => {
		const filtered = await get<CubeResponse>(
			`${query('/api/stats/cube')}&path=${encodeURIComponent('/pricing')}`,
		);
		expect(filtered.cells.reduce((total, cell) => total + cell.pageviews, 0)).toBe(1);
		expect(filtered.cells.reduce((total, cell) => total + cell.events, 0)).toBe(1);

		const read = await cubeStats(
			env,
			{ siteId, start: START, end: END, path: '/pricing' },
			'hour',
		);
		expect(read.metrics.statements).toBe(2);
		expect(read.metrics.rowsRead).toBeGreaterThan(0);
	});

	it('returns totals and freshness without unrelated statistics', async () => {
		const summary = await get<StatsSummaryResponse>(query('/api/stats/summary'));
		expect(summary).toEqual({ summary: { pageviews: 2, visitors: 1, events: 1 } });

		const freshness = await get<StatsFreshnessResponse>(query('/api/stats/freshness'));
		expect(freshness).toEqual({ meta: { materialization: 'hourly', pending: false } });
	});

	it('returns exactly the six realtime lists', async () => {
		const body = await get<RealtimeContextResponse>(query('/api/stats/realtime-context'));
		expect(Object.keys(body).sort()).toEqual([
			'channels',
			'top_countries',
			'top_devices',
			'top_events',
			'top_paths',
			'top_referrers',
		]);
		expect(body.top_paths[0]).toEqual({ key: '/pricing', count: 2 });
		expect(body.top_events).toEqual([{ key: 'purchase', count: 1 }]);
		expect(body.channels).toEqual([
			{ key: 'email', count: 2 },
			{ key: 'organic', count: 1 },
		]);
	});

	it('isolates content, acquisition, technology, engagement, and revenue plans', async () => {
		const content = await get<StatsContentResponse>(query('/api/stats/content'));
		expect(content).toEqual({
			top_paths: [
				{ key: '/pricing', count: 2 },
				{ key: '/', count: 1 },
			],
			top_events: [{ key: 'purchase', count: 1 }],
		});

		const acquisition = await get<StatsAcquisitionResponse>(query('/api/stats/acquisition'));
		expect(acquisition.top_referrers).toEqual([{ key: 'https://search.example/', count: 3 }]);

		const technology = await get<StatsTechnologyResponse>(query('/api/stats/technology'));
		expect(Object.keys(technology).sort()).toEqual([
			'top_browsers',
			'top_connections',
			'top_languages',
			'top_networks',
			'top_os',
			'top_regions',
			'top_screens',
		]);
		expect(technology.top_browsers).toEqual([{ key: 'Chrome', count: 3 }]);

		const engagement = await get<StatsEngagementResponse>(query('/api/stats/engagement'));
		expect(engagement.engagement.sessions).toBe(1);

		const revenue = await get<StatsRevenueResponse>(query('/api/stats/revenue'));
		expect(revenue.revenue).toEqual({ total: 50, orders: 1, aov: 50, currency: 'USD' });
		expect(revenue).not.toHaveProperty('attribution');
	});

	it('applies filters to every new event-backed slice', async () => {
		const suffix = `&path=${encodeURIComponent('/')}`;
		const content = await get<StatsContentResponse>(`${query('/api/stats/content')}${suffix}`);
		expect(content.top_paths).toEqual([{ key: '/', count: 1 }]);

		const acquisition = await get<StatsAcquisitionResponse>(
			`${query('/api/stats/acquisition')}${suffix}`,
		);
		expect(acquisition.top_referrers).toEqual([{ key: 'https://search.example/', count: 1 }]);

		const revenue = await get<StatsRevenueResponse>(`${query('/api/stats/revenue')}${suffix}`);
		expect(revenue.revenue.orders).toBe(0);
	});

	it('isolates the bounded revenue and attribution plan', async () => {
		const body = await get<StatsAttributionResponse>(query('/api/stats/attribution'));
		expect(Object.keys(body).sort()).toEqual(['attribution', 'revenue', 'revenue_by_channel']);
		expect(body.revenue).toEqual({ total: 50, orders: 1, aov: 50, currency: 'USD' });
		expect(body.attribution).toMatchObject({ conversions: 1, revenue: 50 });
		expect(body.attribution.meta).toEqual({
			exact: true,
			truncated: false,
			rows_scanned: 3,
			range_supported: true,
		});
	});

	it('keeps the legacy full response compatible', async () => {
		const body = await get<StatsResponse>(query('/api/stats'));
		expect(body.summary).toEqual({ pageviews: 2, visitors: 1, events: 1 });
		expect(body).toHaveProperty('engagement');
		expect(body).toHaveProperty('attribution');
		expect(body).toHaveProperty('top_browsers');
	});

	it('applies the existing site and range guards', async () => {
		const wrongSite = await app.request(
			`/api/stats/core?site_id=${crypto.randomUUID()}&start=${START}&end=${END}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(wrongSite.status).toBe(403);

		const badRange = await app.request(
			`/api/stats/summary?site_id=${siteId}&start=${END}&end=${START}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(badRange.status).toBe(400);

		const unauthorized = await app.request(query('/api/stats/technology'), {}, env);
		expect(unauthorized.status).toBe(401);
	});
});
