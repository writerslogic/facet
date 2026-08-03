// The five visualization reads: /stats/distribution, /stats/timeseries, /stats/path-tree,
// /stats/journeys and /stats/clock.
//
// A distribution endpoint that is subtly wrong is worse than none — a chart makes a wrong number
// look authoritative — so every statistic here is asserted against a HAND-COMPUTED value over a
// seeded set small enough to check by eye, not against whatever the implementation happens to
// return. The same goes for the anonymity floors: each one is pinned from BOTH sides (just below it
// withholds, just above it answers), because a floor that silently stopped applying would look
// exactly like a working endpoint.
//
// Auth, site-scoping and range-capping are asserted for every endpoint in one table-driven block:
// these are new public surface, and a read that forgot `requireSiteAccess` is the one bug that
// cannot be caught by looking at its output.

import { env } from 'cloudflare:test';
import type {
	ClockResponse,
	DimensionSeriesResponse,
	JourneysResponse,
	PathTreeNode,
	PathTreeResponse,
	SessionDistributionResponse,
} from '@facet/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { issueKey } from '../src/lib/apikeys.js';

const app = createApp();
const SITE = '11111111-1111-4111-8111-111111111111';
const OTHER_SITE = '22222222-2222-4222-8222-222222222222';
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** 2026-01-01T00:00:00Z — a Thursday (UTC day index 4), which the clock assertions depend on. */
const T0 = Date.UTC(2026, 0, 1);
const DAY_KEY = '2026-01-01';

async function key(): Promise<string> {
	return (await issueKey(env, SITE, null, Date.now())).key;
}

async function get(path: string, qs: string, apiKey: string | null): Promise<Response> {
	return app.request(
		`${path}?${qs}`,
		apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {},
		env,
	);
}

async function ok<T>(path: string, qs: string, apiKey: string): Promise<T> {
	const res = await get(path, qs, apiKey);
	expect(res.status, `${path} → ${await res.clone().text()}`).toBe(200);
	return (await res.json()) as T;
}

interface EventSeed {
	path?: string;
	referrer?: string;
	name?: string | null;
	at: number;
	visitor?: string;
	country?: string | null;
	device?: string | null;
	channel?: string | null;
	siteId?: string;
}

async function seedEvent(seed: EventSeed): Promise<void> {
	await db(env)
		.insert(schema.events)
		.values({
			id: crypto.randomUUID(),
			siteId: seed.siteId ?? SITE,
			hostname: 'acme.com',
			path: seed.path ?? '/',
			referrer: seed.referrer ?? '',
			name: seed.name ?? null,
			props: null,
			visitorHash: seed.visitor ?? 'v1',
			country: seed.country ?? 'US',
			device: seed.device ?? 'desktop',
			createdAt: seed.at,
			channel: seed.channel ?? 'direct',
		});
}

/** Seed `count` identical pageviews (distinct ids, same bucket) — the volume knob for top-N tests. */
async function seedPageviews(count: number, seed: EventSeed): Promise<void> {
	for (let i = 0; i < count; i++) {
		await seedEvent({ ...seed, visitor: seed.visitor ?? `v${i}` });
	}
}

interface SessionSeed {
	startedAt: number;
	durationMs: number;
	pageviews: number;
	entryPath?: string;
	exitPath?: string;
	channel?: string | null;
	visitor?: string;
	siteId?: string;
}

async function seedSession(id: string, s: SessionSeed): Promise<void> {
	await db(env)
		.insert(schema.eventSessions)
		.values({
			id,
			siteId: s.siteId ?? SITE,
			visitorHash: s.visitor ?? id,
			dayKey: DAY_KEY,
			startedAt: s.startedAt,
			endedAt: s.startedAt + s.durationMs,
			entryPath: s.entryPath ?? '/',
			exitPath: s.exitPath ?? '/',
			channel: s.channel ?? 'direct',
			pageviews: s.pageviews,
			events: 0,
			durationMs: s.durationMs,
			isBounce: s.pageviews <= 1 ? 1 : 0,
		});
}

// =================================================================================================
// Every endpoint is API-key authenticated, site-scoped and range-capped, exactly like its siblings.
// =================================================================================================

const ENDPOINTS: { path: string; extra?: string }[] = [
	{ path: '/api/stats/distribution' },
	{ path: '/api/stats/timeseries', extra: '&dimension=path' },
	{ path: '/api/stats/path-tree' },
	{ path: '/api/stats/journeys' },
	{ path: '/api/stats/clock' },
];

describe('visualization reads: auth, site scope and range cap', () => {
	for (const { path, extra = '' } of ENDPOINTS) {
		const range = `site_id=${SITE}&start=${T0}&end=${T0 + DAY}${extra}`;

		it(`${path} requires an API key`, async () => {
			const res = await get(path, range, null);
			expect(res.status).toBe(401);
		});

		it(`${path} refuses a key issued for another site`, async () => {
			const res = await get(
				path,
				`site_id=${OTHER_SITE}&start=${T0}&end=${T0 + DAY}${extra}`,
				await key(),
			);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: 'site_mismatch' });
		});

		it(`${path} rejects an empty range`, async () => {
			const res = await get(
				path,
				`site_id=${SITE}&start=${T0}&end=${T0}${extra}`,
				await key(),
			);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'bad_range' });
		});

		it(`${path} rejects a range past the 90-day cap`, async () => {
			const res = await get(
				path,
				`site_id=${SITE}&start=${T0}&end=${T0 + 91 * DAY}${extra}`,
				await key(),
			);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'range_too_large' });
		});
	}

	it('/api/stats/timeseries rejects a missing or unknown dimension', async () => {
		const apiKey = await key();
		const range = `site_id=${SITE}&start=${T0}&end=${T0 + DAY}`;
		expect((await get('/api/stats/timeseries', range, apiKey)).status).toBe(400);
		expect(
			(await get('/api/stats/timeseries', `${range}&dimension=browser`, apiKey)).status,
		).toBe(400);
	});

	it('scopes every read to the authenticated site', async () => {
		const apiKey = await key();
		// Above the tree's k-anonymity floor on both sites, so a cross-site leak would be labelled
		// rather than folded into `other` — otherwise this would pass for the wrong reason.
		await seedPageviews(3, { path: '/only-on-mine', at: T0 + HOUR });
		await seedPageviews(3, { path: '/only-on-theirs', at: T0 + HOUR, siteId: OTHER_SITE });
		await seedSession('mine', { startedAt: T0 + HOUR, durationMs: 1000, pageviews: 2 });
		await seedSession('theirs', {
			startedAt: T0 + HOUR,
			durationMs: 1000,
			pageviews: 2,
			siteId: OTHER_SITE,
			entryPath: '/only-on-theirs',
		});

		const qs = `site_id=${SITE}&start=${T0}&end=${T0 + DAY}`;
		const tree = await ok<PathTreeResponse>('/api/stats/path-tree', qs, apiKey);
		expect(JSON.stringify(tree)).toContain('only-on-mine');
		expect(JSON.stringify(tree)).not.toContain('only-on-theirs');

		const dist = await ok<SessionDistributionResponse>('/api/stats/distribution', qs, apiKey);
		expect(dist.count).toBe(1);

		const clock = await ok<ClockResponse>('/api/stats/clock', qs, apiKey);
		expect(clock.by_hour.reduce((a, b) => a + b, 0)).toBe(3);
	});
});

// =================================================================================================
// 1. Session distribution.
// =================================================================================================

/**
 * 25 sessions with `duration_ms = i * 1000` and `pageviews = i` for i = 0..24 — one more than the
 * suppression floor, and an arithmetic sample whose every order statistic can be read off by hand.
 *
 * With n = 25 the nearest-rank-lower index is `floor(p * 24)`:
 *   p05 → 1, p10 → 2, p25 → 6, p50 → 12, p75 → 18, p90 → 21, p95 → 22, p99 → 23.
 * The sorted sample is `[0, 1, …, 24]`, so the index IS the pageview value and 1000× it is the
 * duration.
 */
async function seedDistributionSample(count = 25, channel = 'direct'): Promise<void> {
	for (let i = 0; i < count; i++) {
		await seedSession(`d${i}-${channel}`, {
			startedAt: T0 + i * 60_000,
			durationMs: i * 1000,
			pageviews: i,
			channel,
		});
	}
}

const RANGE = `site_id=${SITE}&start=${T0}&end=${T0 + DAY}`;

describe('GET /api/stats/distribution', () => {
	it('computes percentiles by nearest-rank-lower over the exact seeded sample', async () => {
		const apiKey = await key();
		await seedDistributionSample();
		const body = await ok<SessionDistributionResponse>(
			'/api/stats/distribution',
			RANGE,
			apiKey,
		);

		expect(body.count).toBe(25);
		expect(body.suppressed).toBe(false);
		expect(body.min_count).toBe(25);
		expect(body.percentile_method).toBe('nearest-rank-lower');

		// Hand-computed from `[0, 1, …, 24]`: index floor(p * 24), value = index.
		expect(body.pageviews?.percentiles).toEqual({
			p05: 1,
			p10: 2,
			p25: 6,
			p50: 12,
			p75: 18,
			p90: 21,
			p95: 22,
			p99: 23,
		});
		expect(body.pageviews?.min).toBe(0);
		expect(body.pageviews?.max).toBe(24);
		// mean of 0..24 = 300 / 25.
		expect(body.pageviews?.mean).toBe(12);

		// Same sample scaled by 1000ms, so the same indices give 1000× the value.
		expect(body.duration_ms?.percentiles).toEqual({
			p05: 1_000,
			p10: 2_000,
			p25: 6_000,
			p50: 12_000,
			p75: 18_000,
			p90: 21_000,
			p95: 22_000,
			p99: 23_000,
		});
		expect(body.duration_ms?.min).toBe(0);
		expect(body.duration_ms?.max).toBe(24_000);
		expect(body.duration_ms?.mean).toBe(12_000);
	});

	it('returns histograms that partition the sample, so the bins sum to the count', async () => {
		const apiKey = await key();
		await seedDistributionSample();
		const body = await ok<SessionDistributionResponse>(
			'/api/stats/distribution',
			RANGE,
			apiKey,
		);

		// pages 0..24 against edges [1,2,3,4,5,6,11,21]: one each below 1 and in 1..5, then
		// 6-10 (five), 11-20 (ten), 21+ (four).
		expect(body.pageviews?.histogram.map((b) => b.count)).toEqual([1, 1, 1, 1, 1, 1, 5, 10, 4]);
		// durations 0..24000ms against edges [1s,5s,15s,30s,…]: {0}, {1..4s}, {5..14s}, {15..24s}.
		expect(body.duration_ms?.histogram.map((b) => b.count)).toEqual([
			1, 4, 10, 10, 0, 0, 0, 0, 0, 0,
		]);

		for (const metric of [body.pageviews, body.duration_ms]) {
			expect(metric?.histogram.reduce((sum, b) => sum + b.count, 0)).toBe(body.count);
			// The bins tile the domain: each `from` is the previous `to`, and the last is open-ended.
			const bins = metric?.histogram ?? [];
			expect(bins[0]?.from).toBe(0);
			expect(bins[bins.length - 1]?.to).toBeNull();
			for (let i = 1; i < bins.length; i++) {
				expect(bins[i]?.from).toBe(bins[i - 1]?.to);
			}
		}
	});

	// The floor from both sides. One session either way decides whether ANY statistic is emitted —
	// a floor that stopped applying would still return plausible-looking numbers.
	it('withholds every statistic one session below the floor, and answers one above it', async () => {
		const apiKey = await key();
		await seedDistributionSample(24);
		const under = await ok<SessionDistributionResponse>(
			'/api/stats/distribution',
			RANGE,
			apiKey,
		);
		expect(under.count).toBe(24);
		expect(under.suppressed).toBe(true);
		expect(under.duration_ms).toBeNull();
		expect(under.pageviews).toBeNull();

		await seedSession('one-more', { startedAt: T0, durationMs: 1, pageviews: 1 });
		const over = await ok<SessionDistributionResponse>(
			'/api/stats/distribution',
			RANGE,
			apiKey,
		);
		expect(over.count).toBe(25);
		expect(over.suppressed).toBe(false);
		expect(over.duration_ms).not.toBeNull();
	});

	it('reports an empty range as suppressed rather than as zeroed statistics', async () => {
		const body = await ok<SessionDistributionResponse>(
			'/api/stats/distribution',
			RANGE,
			await key(),
		);
		expect(body).toMatchObject({
			count: 0,
			suppressed: true,
			duration_ms: null,
			pageviews: null,
		});
	});

	it('slices by channel, the one filter a session row can answer', async () => {
		const apiKey = await key();
		await seedDistributionSample(25, 'direct');
		await seedDistributionSample(4, 'organic');

		const direct = await ok<SessionDistributionResponse>(
			'/api/stats/distribution',
			`${RANGE}&channel=direct`,
			apiKey,
		);
		expect(direct.count).toBe(25);
		expect(direct.suppressed).toBe(false);

		const organic = await ok<SessionDistributionResponse>(
			'/api/stats/distribution',
			`${RANGE}&channel=organic`,
			apiKey,
		);
		expect(organic.count).toBe(4);
		expect(organic.suppressed).toBe(true);
	});

	// Silently ignoring a filter would answer the UNFILTERED distribution under a filtered label —
	// the exact failure a chart cannot show you. Rejecting is the contract.
	it('rejects a filter that `event_sessions` cannot answer instead of ignoring it', async () => {
		const apiKey = await key();
		await seedDistributionSample();
		for (const filter of [
			'device=mobile',
			'country=US',
			'path=/',
			'referrer=x',
			'hostname=a.b',
		]) {
			const res = await get('/api/stats/distribution', `${RANGE}&${filter}`, apiKey);
			expect(res.status, filter).toBe(400);
			const body = (await res.json()) as { error: string; message?: string };
			expect(body.error).toBe('unsupported_filter');
			expect(body.message).toContain(filter.split('=')[0] as string);
		}
	});
});

// =================================================================================================
// 2. Per-dimension time series.
// =================================================================================================

/** /a: 5 pageviews day 1 + 3 pageviews and 3 named events day 2. /b: 4 on day 1 only. /c: 3 on day 2
 * only. /rare: 2 on day 1 — below `K_ANON`, so it must never become a line. */
async function seedSeriesSample(): Promise<void> {
	await seedPageviews(5, { path: '/a', at: T0 + HOUR });
	await seedPageviews(3, { path: '/a', at: T0 + DAY + HOUR });
	await seedPageviews(3, { path: '/a', at: T0 + DAY + HOUR, name: 'signup' });
	await seedPageviews(4, { path: '/b', at: T0 + HOUR });
	await seedPageviews(3, { path: '/c', at: T0 + DAY + HOUR });
	await seedPageviews(2, { path: '/rare', at: T0 + HOUR });
}

const TWO_DAYS = `site_id=${SITE}&start=${T0}&end=${T0 + 2 * DAY}&interval=day`;

describe('GET /api/stats/timeseries', () => {
	it('returns one zero-filled line per top key, ranked over the whole range', async () => {
		const apiKey = await key();
		await seedSeriesSample();
		const body = await ok<DimensionSeriesResponse>(
			'/api/stats/timeseries',
			`${TWO_DAYS}&dimension=path`,
			apiKey,
		);

		expect(body.dimension).toBe('path');
		expect(body.interval).toBe('day');
		expect(body.truncated).toBe(false);
		expect(body.series.map((s) => [s.key, s.total])).toEqual([
			['/a', 8],
			['/b', 4],
			['/c', 3],
		]);

		// Every line spans the same two buckets, zero-filled — that is what makes them stackable.
		for (const line of body.series) {
			expect(line.points.map((p) => p.t)).toEqual([T0, T0 + DAY]);
		}
		expect(body.series[0]?.points).toEqual([
			{ t: T0, pageviews: 5, events: 0 },
			{ t: T0 + DAY, pageviews: 3, events: 3 },
		]);
		expect(body.series[1]?.points).toEqual([
			{ t: T0, pageviews: 4, events: 0 },
			{ t: T0 + DAY, pageviews: 0, events: 0 },
		]);
		expect(body.series[2]?.points).toEqual([
			{ t: T0, pageviews: 0, events: 0 },
			{ t: T0 + DAY, pageviews: 3, events: 0 },
		]);
	});

	// `visitors` per (key, bucket) is not additive along either axis, and a multi-line chart invites
	// summing. The contract is that the field does not exist — assert the bytes, not just the type.
	it('never emits a per-key `visitors` field', async () => {
		const apiKey = await key();
		await seedSeriesSample();
		const raw = await (
			await get('/api/stats/timeseries', `${TWO_DAYS}&dimension=path`, apiKey)
		).text();
		expect(raw).not.toContain('visitors');
	});

	it('keeps a key below the k-anonymity floor out of the chart entirely', async () => {
		const apiKey = await key();
		await seedSeriesSample();
		const body = await ok<DimensionSeriesResponse>(
			'/api/stats/timeseries',
			`${TWO_DAYS}&dimension=path&limit=8`,
			apiKey,
		);
		expect(body.series.map((s) => s.key)).not.toContain('/rare');
	});

	it('bounds the line count and reports that a tail was dropped', async () => {
		const apiKey = await key();
		await seedSeriesSample();
		const body = await ok<DimensionSeriesResponse>(
			'/api/stats/timeseries',
			`${TWO_DAYS}&dimension=path&limit=2`,
			apiKey,
		);
		expect(body.series.map((s) => s.key)).toEqual(['/a', '/b']);
		expect(body.truncated).toBe(true);
	});

	it('refuses a limit outside the bounded range rather than clamping it silently', async () => {
		const apiKey = await key();
		for (const limit of ['0', '9', '-1', 'abc']) {
			const res = await get(
				'/api/stats/timeseries',
				`${TWO_DAYS}&dimension=path&limit=${limit}`,
				apiKey,
			);
			expect(res.status, limit).toBe(400);
		}
	});

	it('answers the other dimensions from the same shape', async () => {
		const apiKey = await key();
		await seedPageviews(4, { path: '/a', at: T0 + HOUR, referrer: 'https://a.example/' });
		await seedPageviews(3, { path: '/a', at: T0 + HOUR, country: 'DE', channel: 'organic' });

		const referrers = await ok<DimensionSeriesResponse>(
			'/api/stats/timeseries',
			`${TWO_DAYS}&dimension=referrer`,
			apiKey,
		);
		// An empty referrer is a direct hit, not a plottable line.
		expect(referrers.series.map((s) => s.key)).toEqual(['https://a.example/']);

		const countries = await ok<DimensionSeriesResponse>(
			'/api/stats/timeseries',
			`${TWO_DAYS}&dimension=country`,
			apiKey,
		);
		expect(countries.series.map((s) => [s.key, s.total])).toEqual([
			['US', 4],
			['DE', 3],
		]);
	});

	it('honours the dimension filters `/api/stats` accepts', async () => {
		const apiKey = await key();
		await seedSeriesSample();
		const body = await ok<DimensionSeriesResponse>(
			'/api/stats/timeseries',
			`${TWO_DAYS}&dimension=path&device=mobile`,
			apiKey,
		);
		expect(body.series).toEqual([]);
	});
});

// =================================================================================================
// 3. Path hierarchy.
// =================================================================================================

/** Find a node by its full path anywhere in the tree, for assertions that do not care about order. */
function findNode(node: PathTreeNode, path: string): PathTreeNode | undefined {
	if (node.path === path) return node;
	for (const child of node.children) {
		const hit = findNode(child, path);
		if (hit) return hit;
	}
	return undefined;
}

describe('GET /api/stats/path-tree', () => {
	it('rolls sibling pages up under their shared prefix', async () => {
		const apiKey = await key();
		await seedPageviews(5, { path: '/', at: T0 + HOUR });
		await seedPageviews(4, { path: '/blog/post-a', at: T0 + HOUR });
		await seedPageviews(3, { path: '/blog/post-b', at: T0 + HOUR });
		await seedPageviews(3, { path: '/docs', at: T0 + HOUR });

		const body = await ok<PathTreeResponse>('/api/stats/path-tree', RANGE, apiKey);
		expect(body.max_depth).toBe(4);
		expect(body.min_count).toBe(3);
		expect(body.paths).toBe(4);
		expect(body.truncated).toBe(false);

		// The root's subtree total is every pageview in the range, so a treemap's outer area
		// reconciles with `summary.pageviews`; `self` is the home page alone.
		expect(body.root).toMatchObject({ path: '/', depth: 0, pageviews: 15, self: 5 });
		expect(body.root.children.map((c) => [c.path, c.pageviews])).toEqual([
			['/blog', 7],
			['/docs', 3],
		]);
		// `/blog` is a pure container: it holds its children's pageviews but none of its own.
		expect(findNode(body.root, '/blog')).toMatchObject({ pageviews: 7, self: 0, depth: 1 });
		expect(findNode(body.root, '/blog/post-a')).toMatchObject({
			pageviews: 4,
			self: 4,
			depth: 2,
			segment: 'post-a',
		});
		expect(findNode(body.root, '/docs')).toMatchObject({ pageviews: 3, self: 3, depth: 1 });
	});

	// A URL is attacker-controlled text a site can accidentally put an identifier in. A one-hit path
	// must not be labelled — but folding it away must not lose its pageviews either.
	it('folds a below-floor subtree into `other` without losing its count', async () => {
		const apiKey = await key();
		await seedPageviews(4, { path: '/blog/post-a', at: T0 + HOUR });
		await seedPageviews(1, { path: '/blog/user-4f2a-secret', at: T0 + HOUR });

		const body = await ok<PathTreeResponse>('/api/stats/path-tree', RANGE, apiKey);
		expect(JSON.stringify(body)).not.toContain('secret');

		const blog = findNode(body.root, '/blog');
		expect(blog?.pageviews).toBe(5);
		const other = blog?.children.find((c) => c.other);
		expect(other).toMatchObject({ segment: '…', pageviews: 1, other: true });
		// Children still sum to the parent's subtree total, so no area vanishes from the treemap.
		expect(blog?.children.reduce((sum, c) => sum + c.pageviews, 0)).toBe(5);
	});

	it('stops at the depth cap, crediting a deeper URL to its ancestor there', async () => {
		const apiKey = await key();
		await seedPageviews(3, { path: '/a/b/c/d/e/f', at: T0 + HOUR });

		const body = await ok<PathTreeResponse>('/api/stats/path-tree', RANGE, apiKey);
		const deepest = findNode(body.root, '/a/b/c/d');
		expect(deepest).toMatchObject({ depth: 4, pageviews: 3, self: 3 });
		expect(deepest?.children).toEqual([]);
		expect(findNode(body.root, '/a/b/c/d/e')).toBeUndefined();
	});

	it('normalizes the query string and duplicate slashes onto the same node', async () => {
		const apiKey = await key();
		await seedPageviews(2, { path: '/blog/post-a?utm_source=x', at: T0 + HOUR });
		await seedPageviews(2, { path: '/blog//post-a/', at: T0 + HOUR });

		const body = await ok<PathTreeResponse>('/api/stats/path-tree', RANGE, apiKey);
		expect(findNode(body.root, '/blog/post-a')?.pageviews).toBe(4);
	});

	it('counts pageviews only, so a custom event does not inflate a node', async () => {
		const apiKey = await key();
		await seedPageviews(3, { path: '/checkout', at: T0 + HOUR });
		await seedPageviews(9, { path: '/checkout', at: T0 + HOUR, name: 'purchase' });

		const body = await ok<PathTreeResponse>('/api/stats/path-tree', RANGE, apiKey);
		expect(body.root.pageviews).toBe(3);
	});
});

// =================================================================================================
// 4. Entry → exit journeys.
// =================================================================================================

describe('GET /api/stats/journeys', () => {
	it('floors on distinct visitors, not sessions, and reports what it withheld', async () => {
		const apiKey = await key();
		// Three different people took /→/pricing: surfaced.
		for (const v of ['v1', 'v2', 'v3']) {
			await seedSession(`p-${v}`, {
				startedAt: T0 + HOUR,
				durationMs: 5_000,
				pageviews: 2,
				entryPath: '/',
				exitPath: '/pricing',
				visitor: v,
			});
		}
		// One person reloaded three times. Three SESSIONS, one visitor — must not clear the floor.
		for (const i of [0, 1, 2]) {
			await seedSession(`reload-${i}`, {
				startedAt: T0 + 2 * HOUR + i,
				durationMs: 0,
				pageviews: 1,
				entryPath: '/',
				exitPath: '/',
				visitor: 'solo',
			});
		}
		// Two people: still under the floor.
		for (const v of ['v4', 'v5']) {
			await seedSession(`b-${v}`, {
				startedAt: T0 + 3 * HOUR,
				durationMs: 9_000,
				pageviews: 3,
				entryPath: '/blog',
				exitPath: '/signup',
				visitor: v,
			});
		}

		const body = await ok<JourneysResponse>('/api/stats/journeys', RANGE, apiKey);
		expect(body.min_visitors).toBe(3);
		expect(body.pairs).toEqual([{ entry: '/', exit: '/pricing', sessions: 3 }]);
		expect(body.sessions).toBe(3);
		// 3 surfaced + 3 reloads + 2 blog sessions: the caller can see 5 sessions were withheld.
		expect(body.total_sessions).toBe(8);
		expect(body.meta).toEqual({ materialization: 'hourly', pending: false });
	});

	it('treats a single-page visit as a real journey, not a placeholder', async () => {
		const apiKey = await key();
		for (const v of ['v1', 'v2', 'v3', 'v4']) {
			await seedSession(`bounce-${v}`, {
				startedAt: T0 + HOUR,
				durationMs: 0,
				pageviews: 1,
				entryPath: '/landing',
				exitPath: '/landing',
				visitor: v,
			});
		}
		const body = await ok<JourneysResponse>('/api/stats/journeys', RANGE, apiKey);
		expect(body.pairs).toEqual([{ entry: '/landing', exit: '/landing', sessions: 4 }]);
	});

	it('returns no pairs at all when nothing clears the floor', async () => {
		const apiKey = await key();
		await seedSession('lonely', {
			startedAt: T0 + HOUR,
			durationMs: 1000,
			pageviews: 2,
			entryPath: '/secret-invite-4f2a',
			exitPath: '/thanks',
		});
		const body = await ok<JourneysResponse>('/api/stats/journeys', RANGE, apiKey);
		expect(body.pairs).toEqual([]);
		expect(body.sessions).toBe(0);
		expect(body.total_sessions).toBe(1);
	});
});

// =================================================================================================
// 5. Hour-of-day / day-of-week.
// =================================================================================================

describe('GET /api/stats/clock', () => {
	it('buckets by UTC hour and UTC weekday, with a fixed 7 × 24 grid', async () => {
		const apiKey = await key();
		// T0 is a Thursday; assert that from the platform too, so a wrong anchor fails loudly here
		// rather than silently shifting every expectation below.
		expect(new Date(T0).getUTCDay()).toBe(4);
		expect(new Date(T0 + 3 * DAY).getUTCDay()).toBe(0);

		await seedPageviews(3, { at: T0 + 5 * HOUR });
		await seedEvent({ at: T0 + 5 * HOUR, name: 'signup' });
		await seedPageviews(2, { at: T0 + 3 * DAY + 13 * HOUR });

		const body = await ok<ClockResponse>(
			'/api/stats/clock',
			`site_id=${SITE}&start=${T0}&end=${T0 + 7 * DAY}`,
			apiKey,
		);

		expect(body.timezone).toBe('UTC');
		expect(body.cells).toHaveLength(168);
		// Ordered day-major then hour, so a heatmap can index it as `cells[day * 24 + hour]`.
		expect(body.cells[0]).toMatchObject({ day: 0, hour: 0 });
		expect(body.cells[167]).toMatchObject({ day: 6, hour: 23 });
		expect(body.cells[4 * 24 + 5]).toEqual({ day: 4, hour: 5, pageviews: 3, events: 1 });
		expect(body.cells[0 * 24 + 13]).toEqual({ day: 0, hour: 13, pageviews: 2, events: 0 });

		expect(body.by_hour).toHaveLength(24);
		expect(body.by_day).toHaveLength(7);
		expect(body.by_hour[5]).toBe(3);
		expect(body.by_hour[13]).toBe(2);
		expect(body.by_day[4]).toBe(3);
		expect(body.by_day[0]).toBe(2);
		// The marginals are the grid's row/column sums, so both totals must agree.
		expect(body.by_hour.reduce((a, b) => a + b, 0)).toBe(5);
		expect(body.by_day.reduce((a, b) => a + b, 0)).toBe(5);
	});

	it('does not shift the hour by any local timezone', async () => {
		const apiKey = await key();
		// 23:30 UTC. Under any local-time conversion this lands on a different hour AND a different
		// weekday — the exact bug the endpoint's contract forbids.
		await seedPageviews(2, { at: T0 + 23 * HOUR + 30 * 60_000 });
		const body = await ok<ClockResponse>(
			'/api/stats/clock',
			`site_id=${SITE}&start=${T0}&end=${T0 + DAY}`,
			apiKey,
		);
		expect(body.by_hour[23]).toBe(2);
		expect(body.by_day[4]).toBe(2);
	});

	it('returns a fully zeroed grid for an empty range rather than an empty array', async () => {
		const body = await ok<ClockResponse>('/api/stats/clock', RANGE, await key());
		expect(body.cells).toHaveLength(168);
		expect(body.cells.every((c) => c.pageviews === 0 && c.events === 0)).toBe(true);
	});

	it('honours the dimension filters `/api/stats` accepts', async () => {
		const apiKey = await key();
		await seedPageviews(3, { at: T0 + 5 * HOUR, device: 'desktop' });
		await seedPageviews(2, { at: T0 + 5 * HOUR, device: 'mobile' });
		const body = await ok<ClockResponse>('/api/stats/clock', `${RANGE}&device=mobile`, apiKey);
		expect(body.by_hour[5]).toBe(2);
	});
});
