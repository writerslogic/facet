// The cron handler runs rollups + retention in one pass, and isolates job failures so a thrown
// error in one job still lets the others run.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { enforceRetention } from '../src/lib/retention.js';
import { JOBS, type ScheduledJob, runScheduled } from '../src/lib/scheduled.js';

const S = '11111111-1111-4111-8111-111111111111';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 5, 1, 11, 5, 0, 0);
const DAY_START = Date.UTC(2026, 5, 1, 0, 0, 0, 0);
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

interface LedgerRow {
	last_occurrence: number | null;
	cadence_error: string | null;
}

async function ledger(name: string): Promise<LedgerRow | null> {
	return await env.DB.prepare(
		'SELECT last_occurrence, cadence_error FROM scheduled_job_runs WHERE name = ?',
	)
		.bind(name)
		.first<LedgerRow>();
}

async function seedLedger(
	name: string,
	lastOccurrence: number | null,
	cadenceError: string | null,
): Promise<void> {
	await env.DB.prepare(
		'INSERT INTO scheduled_job_runs (name, last_occurrence, cadence_error) VALUES (?, ?, ?)',
	)
		.bind(name, lastOccurrence, cadenceError)
		.run();
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
				cadence: '1h',
				run: () => {
					throw new Error('boom');
				},
			},
			{ name: 'purge', cadence: '1h', run: (e, now) => enforceRetention(e, now) },
		];

		await expect(runScheduled(fakeEvent(NOW), env, jobs)).resolves.toBeUndefined();
		expect(await count('SELECT COUNT(*) AS n FROM events WHERE created_at = ?', OLD)).toBe(0);
	});

	it('does not make an independent job wait behind a slow one', async () => {
		const order: string[] = [];
		const jobs: ScheduledJob[] = [
			{
				name: 'slow',
				cadence: '1h',
				run: async () => {
					order.push('slow-start');
					await new Promise((resolve) => setTimeout(resolve, 20));
					order.push('slow-end');
				},
			},
			{
				name: 'fast',
				cadence: '1h',
				run: async () => {
					order.push('fast');
				},
			},
		];

		await runScheduled(fakeEvent(NOW), env, jobs);
		expect(order).toEqual(['slow-start', 'fast', 'slow-end']);
	});

	it('catches a daily job up exactly once after three missed days', async () => {
		let runs = 0;
		const jobs: ScheduledJob[] = [
			{
				name: 'daily',
				cadence: '24h',
				run: async () => {
					runs += 1;
				},
			},
		];
		await seedLedger('daily', DAY_START - 3 * DAY, null);

		await runScheduled(fakeEvent(NOW), env, jobs);
		await runScheduled(fakeEvent(NOW + HOUR), env, jobs);

		expect(runs).toBe(1);
		expect((await ledger('daily'))?.last_occurrence).toBe(DAY_START);
	});

	it('leaves last_occurrence unset when a run fails, so the next trigger retries', async () => {
		let runs = 0;
		const jobs: ScheduledJob[] = [
			{
				name: 'flaky',
				cadence: '1h',
				run: async () => {
					runs += 1;
					throw new Error('nope');
				},
			},
		];

		await runScheduled(fakeEvent(NOW), env, jobs);
		await runScheduled(fakeEvent(NOW + HOUR), env, jobs);

		expect(runs).toBe(2);
		expect((await ledger('flaky'))?.last_occurrence).toBeNull();
	});

	it('disables only the job whose cadence is malformed and records why', async () => {
		let brokenRan = false;
		let laterRan = false;
		const jobs: ScheduledJob[] = [
			{
				name: 'broken',
				cadence: '30m',
				run: async () => {
					brokenRan = true;
				},
			},
			{
				name: 'later',
				cadence: '1h',
				run: async () => {
					laterRan = true;
				},
			},
		];

		await runScheduled(fakeEvent(NOW), env, jobs);

		expect(brokenRan).toBe(false);
		expect(laterRan).toBe(true);
		expect((await ledger('broken'))?.cadence_error).toContain('30m');
		expect((await ledger('broken'))?.last_occurrence).toBeNull();
		expect((await ledger('later'))?.cadence_error).toBeNull();
	});

	it('clears a recorded cadence_error once the cadence parses again', async () => {
		const jobs: ScheduledJob[] = [{ name: 'fixed', cadence: '1h', run: async () => {} }];
		await seedLedger('fixed', null, 'invalid cadence "30m"');

		await runScheduled(fakeEvent(NOW), env, jobs);

		expect((await ledger('fixed'))?.cadence_error).toBeNull();
	});
});

// The cadence of the purge job is a privacy guarantee, not a tuning knob: enforceRetention() purges
// on a rolling cutoff, so how often it runs is the worst-case overshoot of the advertised
// RAW_RETENTION_DAYS window. Moving it to a slower cadence to save queries silently retains raw
// visitor data past what the deployment claims, which is why this is pinned rather than reviewed.
describe('retention cadence', () => {
	it('purges on the trigger interval, not a slower one', () => {
		expect(JOBS.find((j) => j.name === 'retention')?.cadence).toBe('1h');
	});
});
