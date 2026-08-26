// The chunked fan-out in db/contact-analytics.ts. D1 refuses a query with more than 100 bound
// parameters, so a hash list longer than the chunk size is split across statements and merged here
// rather than in SQL. Merging is where an aggregate quietly stops being exact, so these tests pin the
// two ways it could: totals that fail to add up, and a ranking assembled from per-chunk prefixes.

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { contactActivity, contactEvents } from '../src/db/contact-analytics.js';
import { D1_MAX_IN_PARAMS } from '../src/lib/constants.js';

const SITE = '66666666-6666-4666-8666-666666666666';

/** Distinct 64-hex hashes, so each lands in exactly one chunk. */
function hash(i: number): string {
	return i.toString(16).padStart(64, '0');
}

async function seed(rows: { hash: string; path: string; at: number }[]): Promise<void> {
	const insert = env.DB.prepare(
		`INSERT INTO events (id, site_id, name, hostname, path, referrer, visitor_hash, created_at)
		 VALUES (?, ?, NULL, 'shop.example.com', ?, '', ?, ?)`,
	);
	for (let i = 0; i < rows.length; i += 400) {
		await env.DB.batch(
			rows
				.slice(i, i + 400)
				.map((r) => insert.bind(crypto.randomUUID(), SITE, r.path, r.hash, r.at)),
		);
	}
}

beforeEach(async () => {
	await env.DB.prepare(
		'INSERT OR IGNORE INTO sites (id, name, domain, created_at) VALUES (?, ?, ?, ?)',
	)
		.bind(SITE, 'Test', 'shop.example.com', Date.now())
		.run();
});

describe('a hash list longer than one query can bind', () => {
	it('adds the totals up across chunks instead of reporting one of them', async () => {
		const n = D1_MAX_IN_PARAMS + 5;
		const hashes = Array.from({ length: n }, (_, i) => hash(i + 1));
		// One pageview per hash, each at a distinct time so the extremes are unambiguous.
		await seed(hashes.map((h, i) => ({ hash: h, path: '/pricing', at: 1_000 + i })));

		const activity = await contactActivity(env, SITE, hashes);
		expect(activity.total).toBe(n);
		expect(activity.pageviews).toBe(n);
		// first/last must span every chunk, not just the last one processed.
		expect(activity.first_seen).toBe(1_000);
		expect(activity.last_seen).toBe(1_000 + n - 1);
	});

	it('ranks paths over the whole set, not over each chunk separately', async () => {
		// The discriminating case for taking a per-chunk prefix. `/sleeper` is rank 13 within BOTH
		// chunks, so any implementation that applied `LIMIT 10` per chunk and merged the survivors
		// would drop it entirely — yet it is the single most-viewed path overall.
		const chunkA = Array.from({ length: D1_MAX_IN_PARAMS }, (_, i) => hash(i + 1));
		const chunkB = Array.from({ length: 5 }, (_, i) => hash(D1_MAX_IN_PARAMS + i + 1));
		const rows: { hash: string; path: string; at: number }[] = [];
		let t = 0;
		const push = (h: string, path: string, times: number) => {
			for (let i = 0; i < times; i++) rows.push({ hash: h, path, at: 5_000 + t++ });
		};
		for (let p = 0; p < 12; p++) push(chunkA[p] as string, `/a${p}`, 12);
		for (let p = 0; p < 12; p++) push(chunkB[p % chunkB.length] as string, `/b${p}`, 12);
		// Ten views in each chunk: below every per-chunk leader, above all of them combined.
		push(chunkA[50] as string, '/sleeper', 10);
		push(chunkB[4] as string, '/sleeper', 10);
		await seed(rows);

		const activity = await contactActivity(env, SITE, [...chunkA, ...chunkB]);
		expect(activity.top_paths[0]).toEqual({ path: '/sleeper', views: 20 });
		expect(activity.total).toBe(12 * 12 + 12 * 12 + 20);
	});

	it('returns the genuinely newest events, not the newest within each chunk', async () => {
		// Same trap for the export: a per-chunk cap concatenated would return the later chunk's older
		// rows ahead of the earlier chunk's newer ones.
		const chunkA = Array.from({ length: D1_MAX_IN_PARAMS }, (_, i) => hash(i + 1));
		const chunkB = [hash(D1_MAX_IN_PARAMS + 1)];
		await seed([
			...chunkA.map((h, i) => ({ hash: h, path: '/old', at: 1_000 + i })),
			{ hash: chunkB[0] as string, path: '/newest', at: 9_999_999 },
		]);

		const events = await contactEvents(env, SITE, [...chunkA, ...chunkB]);
		expect(events[0]?.path).toBe('/newest');
		expect(events.length).toBe(chunkA.length + 1);
	});
});
