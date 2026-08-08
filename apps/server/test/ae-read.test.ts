// The Analytics Engine read path. The subject under test is mostly the SAFETY of a query the vendor
// gives us no bound parameters to build: this proves the literal guard cannot be talked past, that
// the account id reaching the URL — under a bearer token — is validated to its exact shape, that a
// value the guard rejects falls back to D1 instead of silently losing its filter, and that the two
// stores answer the same question. Sampling correction is asserted on the emitted SQL, because no
// local runtime samples.

import { env } from 'cloudflare:test';
import type { BreakdownDimension, StatsFilter } from '@facet/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { breakdown } from '../src/db/breakdown.js';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import type { Env } from '../src/env.js';
import { aeInt, aeLiteral, aeNumber, aeReadable, queryAe } from '../src/lib/ae-sql.js';
import { AE_RETENTION_DAYS, VISITOR_BLOB, blobColumn } from '../src/lib/ae.js';

const SITE = '77777777-7777-4777-8777-777777777777';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const T0 = Date.UTC(2026, 3, 1);
const HOUR = 3_600_000;

/** A fully configured read env. `AE` only has to be present — reads go over HTTP, not the binding. */
function readableEnv(over: Partial<Env> = {}): Env {
	return {
		AE: { writeDataPoint: () => {} },
		AE_BEST_EFFORT_ENABLED: 'true',
		CF_ACCOUNT_ID: ACCOUNT,
		CF_API_TOKEN: 'test-cf-token',
		RAW_RETENTION_DAYS: String(AE_RETENTION_DAYS),
		...over,
	} as unknown as Env;
}

/** A stub `fetch` returning one AE `FORMAT JSON` envelope, recording the request it was given. */
function stubAe(data: unknown[], init: ResponseInit = {}) {
	return vi.fn(async (url: string, req: RequestInit) => {
		void url;
		void req;
		return new Response(JSON.stringify({ meta: [], data, rows: data.length }), {
			status: 200,
			...init,
		});
	});
}

function mk(over: Partial<NewEvent> = {}): NewEvent {
	return {
		siteId: SITE,
		hostname: 'shop.example.com',
		path: '/',
		referrer: '',
		name: null,
		props: null,
		visitorHash: 'v0',
		country: 'US',
		device: 'desktop',
		createdAt: T0,
		...over,
	};
}

describe('aeLiteral', () => {
	it('quotes a value that cannot express syntax', () => {
		expect(aeLiteral('/pricing')).toBe("'/pricing'");
		expect(aeLiteral('')).toBe("''");
		// Non-ASCII is not a syntax risk: it cannot terminate a literal.
		expect(aeLiteral('München')).toBe("'München'");
	});

	it('refuses a quote or a backslash rather than guessing an undocumented escape', () => {
		expect(aeLiteral("' OR 1=1 --")).toBeNull();
		expect(aeLiteral("o'brien")).toBeNull();
		expect(aeLiteral('C:\\Windows')).toBeNull();
		expect(aeLiteral("\\' union select")).toBeNull();
	});

	it('refuses control characters, so a value can never carry a line into the query', () => {
		expect(aeLiteral('a\nb')).toBeNull();
		expect(aeLiteral('a\r\nb')).toBeNull();
		expect(aeLiteral('a\u0000b')).toBeNull();
		expect(aeLiteral('a\u007fb')).toBeNull();
	});
});

describe('aeInt', () => {
	it('renders an exact integer', () => {
		expect(aeInt(0)).toBe('0');
		expect(aeInt(1_775_000_000)).toBe('1775000000');
		expect(aeInt(-5)).toBe('-5');
	});

	it('refuses anything String() would render as something other than digits', () => {
		// 1e21 stringifies to "1e+21", NaN/Infinity to words — each of which changes the query.
		expect(aeInt(1e21)).toBeNull();
		expect(aeInt(Number.NaN)).toBeNull();
		expect(aeInt(Number.POSITIVE_INFINITY)).toBeNull();
		expect(aeInt(1.5)).toBeNull();
	});
});

describe('aeNumber', () => {
	it('reads a 64-bit sum returned as a decimal string', () => {
		expect(aeNumber('120')).toBe(120);
		expect(aeNumber(4.5)).toBe(4.5);
	});

	it('reads anything unusable as zero rather than NaN', () => {
		expect(aeNumber(undefined)).toBe(0);
		expect(aeNumber(null)).toBe(0);
		expect(aeNumber('not a number')).toBe(0);
		expect(aeNumber({})).toBe(0);
	});
});

describe('aeReadable', () => {
	it('is true only for a fully configured deployment', () => {
		expect(aeReadable(readableEnv())).toBe(true);
	});

	it('is false without the dataset binding, since nothing was ever mirrored', () => {
		expect(aeReadable(readableEnv({ AE: undefined }))).toBe(false);
	});

	it('is false without a token', () => {
		expect(aeReadable(readableEnv({ CF_API_TOKEN: '' }))).toBe(false);
		expect(aeReadable(readableEnv({ CF_API_TOKEN: undefined as unknown as string }))).toBe(
			false,
		);
	});

	it('refuses an account id that is not exactly 32 lowercase hex', () => {
		// Each of these lands in the URL path of a request that carries CF_API_TOKEN.
		for (const bad of [
			'',
			'not-an-account',
			`${ACCOUNT}/../../../../foo`,
			`${ACCOUNT}@evil.example`,
			ACCOUNT.toUpperCase(),
			ACCOUNT.slice(0, 31),
			`${ACCOUNT}0`,
		]) {
			expect(aeReadable(readableEnv({ CF_ACCOUNT_ID: bad }))).toBe(false);
		}
	});

	it('is false below the window the write path mirrors at, because nothing was written', () => {
		expect(aeReadable(readableEnv({ RAW_RETENTION_DAYS: String(AE_RETENTION_DAYS - 1) }))).toBe(
			false,
		);
		expect(aeReadable(readableEnv({ RAW_RETENTION_DAYS: String(AE_RETENTION_DAYS) }))).toBe(
			true,
		);
	});
});

describe('queryAe', () => {
	it('posts the query text under a bearer token to the account SQL endpoint', async () => {
		const fetchImpl = stubAe([{ k: 'x' }]);
		const rows = await queryAe(readableEnv(), 'SELECT 1 FORMAT JSON', fetchImpl);
		expect(rows).toEqual([{ k: 'x' }]);
		const [url, req] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toBe(
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`,
		);
		expect(req?.method).toBe('POST');
		expect(req?.body).toBe('SELECT 1 FORMAT JSON');
		expect((req?.headers as Record<string, string>).authorization).toBe('Bearer test-cf-token');
	});

	it('never issues the request at all when the deployment is not configured to read', async () => {
		const fetchImpl = stubAe([{ k: 'x' }]);
		expect(await queryAe({} as Env, 'SELECT 1', fetchImpl)).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('returns null for a rejected, malformed, or failed response', async () => {
		const readable = readableEnv();
		expect(await queryAe(readable, 'SELECT 1', stubAe([], { status: 403 }))).toBeNull();
		expect(await queryAe(readable, 'SELECT 1', stubAe([], { status: 500 }))).toBeNull();
		const notJson = vi.fn(async () => new Response('<html>gateway</html>', { status: 200 }));
		expect(await queryAe(readable, 'SELECT 1', notJson)).toBeNull();
		const noData = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' })));
		expect(await queryAe(readable, 'SELECT 1', noData)).toBeNull();
		const threw = vi.fn(async () => {
			throw new Error('network');
		});
		expect(await queryAe(readable, 'SELECT 1', threw)).toBeNull();
	});
});

describe('blob layout addressing', () => {
	it('maps a mirrored key to its 1-based position', () => {
		expect(blobColumn('hostname')).toBe('blob1');
		expect(blobColumn('path')).toBe('blob2');
		expect(blobColumn('visitorHash')).toBe('blob5');
		expect(blobColumn('currency')).toBe('blob20');
		expect(VISITOR_BLOB).toBe('blob5');
	});
});

describe('breakdown → Analytics Engine SQL', () => {
	const f: StatsFilter = { siteId: SITE, start: T0, end: T0 + 24 * HOUR };

	async function sqlFor(
		filter: StatsFilter = f,
		dimension: BreakdownDimension = 'city',
		limit = 25,
	): Promise<string> {
		const fetchImpl = stubAe([]);
		await breakdown(readableEnv(), filter, dimension, limit, fetchImpl);
		return String(fetchImpl.mock.calls[0]?.[1]?.body ?? '');
	}

	it('groups by the allowlisted blob for the dimension, never by a caller string', async () => {
		expect(await sqlFor(f, 'city')).toContain(`SELECT ${blobColumn('city')} AS k`);
		expect(await sqlFor(f, 'utm_campaign')).toContain(
			`SELECT ${blobColumn('utmCampaign')} AS k`,
		);
		expect(await sqlFor(f, 'event')).toContain(`SELECT ${blobColumn('name')} AS k`);
	});

	it('weights every count by the sampling interval', async () => {
		const sql = await sqlFor();
		expect(sql).toContain('SUM(_sample_interval) AS total');
		expect(sql).toContain('SUM(_sample_interval * double3) AS pageviews');
		expect(sql).toContain('max(_sample_interval) AS sample_interval');
		// A bare count() would report surviving rows as if they were the traffic.
		expect(sql).not.toMatch(/\bcount\(\)/);
	});

	it('reads the visitor column only inside a distinct count, never as a group key', async () => {
		const sql = await sqlFor();
		expect(sql).toContain(`count(DISTINCT ${VISITOR_BLOB}) AS visitors`);
		expect(sql).not.toContain(`${VISITOR_BLOB} AS k`);
		expect(sql).not.toContain(`GROUP BY ${VISITOR_BLOB}`);
	});

	it('applies the k-anonymity floor on distinct visitors, and bounds the rows', async () => {
		const sql = await sqlFor(f, 'city', 7);
		expect(sql).toContain('HAVING visitors >= 3');
		expect(sql).toContain('LIMIT 7');
	});

	it('scopes to the site and the range in whole seconds', async () => {
		const sql = await sqlFor();
		expect(sql).toContain(`index1 = '${SITE}'`);
		expect(sql).toContain(`toUInt32(timestamp) >= ${T0 / 1000}`);
		expect(sql).toContain(`toUInt32(timestamp) < ${(T0 + 24 * HOUR) / 1000}`);
	});

	it('narrows on each filter through its mirrored column', async () => {
		const sql = await sqlFor({
			...f,
			hostname: 'shop.example.com',
			path: '/checkout',
			country: 'GB',
		});
		expect(sql).toContain(`${blobColumn('hostname')} = 'shop.example.com'`);
		expect(sql).toContain(`${blobColumn('path')} = '/checkout'`);
		expect(sql).toContain(`${blobColumn('country')} = 'GB'`);
	});
});

describe('breakdown → fallback to D1', () => {
	const f = { siteId: SITE, start: T0, end: T0 + 24 * HOUR };

	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM events').run();
		// Berlin clears the 3-visitor floor; Paris does not, and must not be surfaced.
		for (const [i, city] of ['Berlin', 'Berlin', 'Berlin', 'Paris', 'Paris'].entries()) {
			await insertEvent(env, mk({ city, visitorHash: `v${i}`, createdAt: T0 + i }));
		}
	});

	it('answers from D1 when the deployment is not configured for columnar reads', async () => {
		const result = await breakdown(env as Env, f, 'city', 25);
		expect(result.source).toBe('d1');
		expect(result.sampled).toBe(false);
		expect(result.rows).toEqual([{ key: 'Berlin', events: 3, pageviews: 3, visitors: 3 }]);
	});

	it('suppresses a group below the k-anonymity floor', async () => {
		const result = await breakdown(env as Env, f, 'city', 25);
		expect(result.rows.map((r) => r.key)).not.toContain('Paris');
	});

	it('reports an absent dimension as the empty string, matching the columnar store', async () => {
		const result = await breakdown(env as Env, f, 'timezone', 25);
		expect(result.rows).toEqual([{ key: '', events: 5, pageviews: 5, visitors: 5 }]);
	});

	it('falls back rather than dropping a filter it cannot express safely', async () => {
		const readable = { ...(env as unknown as Env), ...readableEnv() } as Env;
		for (const path of ["/o'brien", 'C:\\temp', '/a\nb']) {
			const fetchImpl = stubAe([]);
			const result = await breakdown(readable, { ...f, path }, 'city', 25, fetchImpl);
			expect(result.source).toBe('d1');
			// The point: no query was built at all, so no filter could have gone missing from one.
			expect(fetchImpl).not.toHaveBeenCalled();
		}
	});

	it('falls back on an empty filter value, the one value the two stores read differently', async () => {
		// D1 keeps an absent country as NULL (matching nothing), the columnar store as '' (matching
		// every country-less row). Answering from either under the same query string would differ.
		const fetchImpl = stubAe([]);
		const readable = { ...(env as unknown as Env), ...readableEnv() } as Env;
		const result = await breakdown(readable, { ...f, country: '' }, 'city', 25, fetchImpl);
		expect(result.source).toBe('d1');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('falls back when the analytics API rejects the query', async () => {
		const readable = { ...(env as unknown as Env), ...readableEnv() } as Env;
		const result = await breakdown(readable, f, 'city', 25, stubAe([], { status: 500 }));
		expect(result.source).toBe('d1');
		expect(result.rows).toEqual([{ key: 'Berlin', events: 3, pageviews: 3, visitors: 3 }]);
	});
});

describe('breakdown → columnar rows', () => {
	const f = { siteId: SITE, start: T0, end: T0 + 24 * HOUR };

	it('reports whole events from weighted sums, and flags a sampled read', async () => {
		const fetchImpl = stubAe([
			{ k: 'Berlin', total: '120', pageviews: '99.6', visitors: '40', sample_interval: '4' },
			{ k: '', total: 8, pageviews: 8, visitors: 8, sample_interval: 1 },
		]);
		const result = await breakdown(readableEnv(), f, 'city', 25, fetchImpl);
		expect(result.source).toBe('analytics_engine');
		expect(result.sampled).toBe(true);
		expect(result.rows).toEqual([
			{ key: 'Berlin', events: 120, pageviews: 100, visitors: 40 },
			{ key: '', events: 8, pageviews: 8, visitors: 8 },
		]);
	});

	it('is not flagged as sampled when every group was read whole', async () => {
		const fetchImpl = stubAe([
			{ k: 'Berlin', total: 3, pageviews: 3, visitors: 3, sample_interval: 1 },
		]);
		const result = await breakdown(readableEnv(), f, 'city', 25, fetchImpl);
		expect(result.sampled).toBe(false);
	});
});

describe('GET /api/stats/breakdown', () => {
	const app = createApp();
	const ADMIN = 'Bearer test-admin-token';
	let siteId = '';
	let key = '';

	beforeEach(async () => {
		const siteRes = await app.request(
			'/api/sites',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'Acme', domain: 'acme.com' }),
			},
			env,
		);
		siteId = ((await siteRes.json()) as { site: { id: string } }).site.id;
		const keyRes = await app.request(
			'/api/keys',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({ site_id: siteId }),
			},
			env,
		);
		key = ((await keyRes.json()) as { key: string }).key;
		await env.DB.prepare('DELETE FROM events').run();
		for (const [i, city] of ['Berlin', 'Berlin', 'Berlin', 'Paris'].entries()) {
			await insertEvent(env, mk({ siteId, city, visitorHash: `k${i}`, createdAt: T0 + i }));
		}
	});

	function get(query: string, bearer = key) {
		return app.request(
			`/api/stats/breakdown?site_id=${siteId}&start=${T0}&end=${T0 + 24 * HOUR}&${query}`,
			{ headers: { Authorization: `Bearer ${bearer}` } },
			env,
		);
	}

	it('returns the k-anonymised breakdown with the store that answered', async () => {
		const res = await get('dimension=city');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			dimension: 'city',
			source: 'd1',
			sampled: false,
			rows: [{ key: 'Berlin', events: 3, pageviews: 3, visitors: 3 }],
		});
	});

	it('reaches a dimension no other endpoint surfaces', async () => {
		for (const dimension of ['utm_campaign', 'timezone', 'currency', 'form_factor']) {
			expect((await get(`dimension=${dimension}`)).status).toBe(200);
		}
	});

	it('rejects a dimension outside the allowlist rather than reaching for a column', async () => {
		for (const dimension of ['visitor_hash', 'props', 'blob5', '']) {
			const res = await get(`dimension=${encodeURIComponent(dimension)}`);
			expect(res.status).toBe(400);
			expect((await res.json()) as { error: string }).toMatchObject({
				error: 'validation_failed',
			});
		}
	});

	it('requires a dimension, rather than guessing which question was asked', async () => {
		expect((await get('limit=5')).status).toBe(400);
	});

	it('bounds the row count', async () => {
		expect((await get('dimension=city&limit=0')).status).toBe(400);
		expect((await get('dimension=city&limit=201')).status).toBe(400);
		expect((await get('dimension=city&limit=200')).status).toBe(200);
	});

	it('is site-scoped by the API key like every other read', async () => {
		expect((await get('dimension=city', 'clk_not-a-real-key')).status).toBe(401);
	});
});
