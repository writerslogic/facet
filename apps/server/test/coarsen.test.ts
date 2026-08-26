// Tiered granularity: fine rollups fold into a `month` row that converges on re-run, leaves its
// sources in place, and refuses to invent a monthly unique count.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { coarsenRollups } from '../src/lib/coarsen.js';

const S = '11111111-1111-4111-8111-111111111111';
const A = 'a.example.com';
const B = 'b.example.com';
const HOUR = 3_600_000;
const MONTH = Date.UTC(2023, 0, 1);
const DAY_1 = Date.UTC(2023, 0, 1);
const DAY_2 = Date.UTC(2023, 0, 2);
const DAY_3 = Date.UTC(2023, 0, 3);
// Past the 36-month default detail window for the seeded month, short of the 120-month year window.
const NOW = Date.UTC(2026, 2, 15);

interface Row {
	pageviews: number;
	events: number;
	visitors: number;
}

async function seed(
	hostname: string,
	bucketStart: number,
	interval: string,
	pageviews: number,
	events: number,
	visitors: number,
): Promise<void> {
	await env.DB.prepare(
		'INSERT INTO event_rollups (site_id, hostname, bucket_start, interval, pageviews, events, visitors) VALUES (?,?,?,?,?,?,?)',
	)
		.bind(S, hostname, bucketStart, interval, pageviews, events, visitors)
		.run();
}

async function coarse(hostname: string): Promise<Row | null> {
	return env.DB.prepare(
		'SELECT pageviews, events, visitors FROM event_rollups WHERE site_id = ? AND hostname = ? AND bucket_start = ? AND interval = ?',
	)
		.bind(S, hostname, MONTH, 'month')
		.first<Row>();
}

async function fineCount(): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM event_rollups WHERE interval IN ('hour','day')",
	).first<{ n: number }>();
	return row?.n ?? 0;
}

beforeEach(async () => {
	// Days 1 and 2 have a daily row AND the hourly rows it was folded from — the same raw events seen
	// twice. Day 3 has hourly rows only, the shape left behind when the daily pass never ran.
	await seed(A, DAY_1, 'day', 10, 2, 5);
	await seed(A, DAY_1, 'hour', 6, 1, 4);
	await seed(A, DAY_1 + HOUR, 'hour', 4, 1, 3);
	await seed(A, DAY_2, 'day', 20, 3, 8);
	await seed(A, DAY_2, 'hour', 20, 3, 8);
	await seed(A, DAY_3, 'hour', 7, 1, 6);
	await seed(B, DAY_1, 'day', 4, 0, 2);
});

describe('coarsenRollups', () => {
	it('sums each day once, preferring the daily row over the hours it duplicates', async () => {
		await coarsenRollups(env, NOW);
		expect(await coarse(A)).toMatchObject({ pageviews: 37, events: 6 });
		expect(await coarse(B)).toMatchObject({ pageviews: 4, events: 0 });
	});

	it('converges: a second run reproduces the first run’s totals', async () => {
		await coarsenRollups(env, NOW);
		const first = await coarse(A);
		await coarsenRollups(env, NOW);
		expect(await coarse(A)).toEqual(first);

		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM event_rollups WHERE interval = 'month'",
		).first<{ n: number }>();
		expect(rows?.n).toBe(2);
	});

	it('leaves every source row in place', async () => {
		const before = await fineCount();
		await coarsenRollups(env, NOW);
		expect(await fineCount()).toBe(before);
	});

	it('crosses a dormant stretch longer than one run’s budget', async () => {
		// Three years of silence between the two months that have data. A month-by-month walk would
		// exhaust its budget inside the gap, never advance, and repeat the same empty window forever.
		const old = Date.UTC(2020, 0, 1);
		await seed(A, old, 'day', 5, 1, 3);

		await coarsenRollups(env, NOW);

		const row = await env.DB.prepare(
			"SELECT pageviews FROM event_rollups WHERE site_id = ? AND hostname = ? AND bucket_start = ? AND interval = 'month'",
		)
			.bind(S, A, old)
			.first<{ pageviews: number }>();
		expect(row?.pageviews).toBe(5);
		expect(await coarse(A)).toMatchObject({ pageviews: 37 });
	});

	it('reports no visitors rather than a summed one', async () => {
		await coarsenRollups(env, NOW);
		// The sources carry 5 + 8 + 6 = 19 daily uniques for host A; summing them would be a fiction.
		expect((await coarse(A))?.visitors).toBe(0);
	});
});
