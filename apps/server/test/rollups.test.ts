// Rollup aggregation: one event_rollups row per (site, hostname) with exact counts, and
// idempotence (a second run produces identical rows, no duplication or drift).

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { runRollups } from '../src/lib/rollups.js';

const S = '11111111-1111-4111-8111-111111111111';
const HOUR = 3_600_000;
// A fixed completed hour (10:00 UTC) and a `now` five minutes into the next hour.
const BUCKET = Date.UTC(2026, 0, 15, 10, 0, 0, 0);
const NOW = BUCKET + HOUR + 5 * 60_000;
const A = 'a.example.com';
const B = 'b.example.com';

function mk(hostname: string, name: string | null, visitor: string): NewEvent {
	return {
		siteId: S,
		hostname,
		path: '/',
		referrer: '',
		name,
		props: null,
		visitorHash: visitor,
		country: 'US',
		device: 'desktop',
		createdAt: BUCKET + 60_000,
	};
}

interface RollupRow {
	pageviews: number;
	events: number;
	visitors: number;
}

async function rollup(hostname: string): Promise<RollupRow | null> {
	return env.DB.prepare(
		'SELECT pageviews, events, visitors FROM event_rollups WHERE site_id = ? AND hostname = ? AND bucket_start = ? AND interval = ?',
	)
		.bind(S, hostname, BUCKET, 'hour')
		.first<RollupRow>();
}

beforeEach(async () => {
	for (const row of [
		mk(A, null, 'v1'),
		mk(A, null, 'v1'),
		mk(A, null, 'v2'),
		mk(A, 'signup', 'v1'),
		mk(B, null, 'v3'),
		mk(B, null, 'v4'),
	]) {
		await insertEvent(env, row);
	}
});

describe('runRollups', () => {
	it('writes one rollup row per hostname with exact counts', async () => {
		await runRollups(env, NOW);
		expect(await rollup(A)).toEqual({ pageviews: 3, events: 1, visitors: 2 });
		expect(await rollup(B)).toEqual({ pageviews: 2, events: 0, visitors: 2 });
	});

	it('is idempotent: a second run leaves identical rows and no duplicates', async () => {
		await runRollups(env, NOW);
		await runRollups(env, NOW);
		expect(await rollup(A)).toEqual({ pageviews: 3, events: 1, visitors: 2 });
		const count = await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM event_rollups WHERE bucket_start = ? AND interval = ?',
		)
			.bind(BUCKET, 'hour')
			.first<{ n: number }>();
		expect(count?.n).toBe(2);
	});
});
