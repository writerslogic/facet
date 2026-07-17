// The cron handler runs rollups + retention in one pass, and isolates job failures so a thrown
// error in one job still lets the others run.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { enforceRetention } from '../src/lib/retention.js';
import { type ScheduledJob, runScheduled } from '../src/lib/scheduled.js';

const S = '11111111-1111-4111-8111-111111111111';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1, 11, 5, 0, 0);
const BUCKET = Date.UTC(2026, 5, 1, 10, 0, 0, 0);
const OLD = NOW - 100 * DAY;

function fakeEvent(now: number): ScheduledController {
	return {
		scheduledTime: now,
		cron: '0 * * * *',
		noRetry() {},
	} as unknown as ScheduledController;
}

function mk(name: string | null, createdAt: number, visitor: string): NewEvent {
	return {
		siteId: S,
		hostname: 'h.example.com',
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

async function count(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await env.DB.prepare(sql)
		.bind(...binds)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe('runScheduled', () => {
	it('rolls up the completed hour and purges stale raw rows in one pass', async () => {
		await insertEvent(env, mk(null, BUCKET + 30 * 60_000, 'v1'));
		await insertEvent(env, mk(null, BUCKET + 31 * 60_000, 'v2'));
		await insertEvent(env, mk(null, OLD, 'v-old'));

		await runScheduled(fakeEvent(NOW), env);

		const rollup = await env.DB.prepare(
			'SELECT pageviews, visitors FROM event_rollups WHERE bucket_start = ? AND interval = ?',
		)
			.bind(BUCKET, 'hour')
			.first<{ pageviews: number; visitors: number }>();
		expect(rollup).toEqual({ pageviews: 2, visitors: 2 });
		expect(await count('SELECT COUNT(*) AS n FROM events WHERE created_at = ?', OLD)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM events')).toBe(2);
	});

	it('runs remaining jobs even when an earlier job throws', async () => {
		await insertEvent(env, mk(null, OLD, 'v-old'));
		const jobs: ScheduledJob[] = [
			{
				name: 'boom',
				run: () => {
					throw new Error('boom');
				},
			},
			{ name: 'retention', run: (e, now) => enforceRetention(e, now) },
		];

		await expect(runScheduled(fakeEvent(NOW), env, jobs)).resolves.toBeUndefined();
		expect(await count('SELECT COUNT(*) AS n FROM events WHERE created_at = ?', OLD)).toBe(0);
	});
});
