// Cohort-retention triangle over seeded `sessions`: cohort sizing, a returning visitor counting as
// retained, week bucketing, and the salt-window reality (a rotated hash across days is a NEW visitor,
// so at the daily grain cross-period retention is honestly ~0).

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { cohortRetention } from '../src/db/stats.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const DAY_MS = 86_400_000;

function dayKey(offset: number): string {
	return new Date(Date.UTC(2026, 0, 5) + offset * DAY_MS).toISOString().slice(0, 10);
}
function ms(offset: number): number {
	return Date.UTC(2026, 0, 5) + offset * DAY_MS;
}

async function seedSession(visitor: string, dayOffset: number): Promise<void> {
	await db(env)
		.insert(schema.sessions)
		.values({
			siteId: SITE,
			visitorHash: visitor,
			dayKey: dayKey(dayOffset),
			firstSeen: ms(dayOffset),
		});
}

const f = { siteId: SITE, start: ms(0), end: ms(40) };

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM sessions').run();
});

describe('cohortRetention (week)', () => {
	it('sizes cohorts by first-activity week and counts a later-period return as retained', async () => {
		// Jan 5 2026 is a Monday, so day 0 = week 0, day 7 = week 1, day 14 = week 2.
		// wk0 stable id present again in wk0 (return) and wk1 (return): only possible under a wider salt window.
		await seedSession('stable-a', 0); // cohort week 0
		await seedSession('stable-a', 7); // returns in week 1
		await seedSession('stable-a', 14); // returns in week 2
		await seedSession('stable-b', 0); // cohort week 0, never returns
		await seedSession('stable-c', 7); // cohort week 1

		const r = await cohortRetention(env, f, 'week');
		expect(r.period).toBe('week');
		const wk0 = r.cohorts.find((c) => c.cohort === dayKey(0));
		expect(wk0?.size).toBe(2);
		// period 0 = 100%, period 1 = 1/2 (only stable-a returned), period 2 = 1/2.
		expect(wk0?.retention).toEqual([1, 0.5, 0.5]);
		const wk1 = r.cohorts.find((c) => c.cohort === dayKey(7));
		expect(wk1?.size).toBe(1);
		expect(wk1?.retention).toEqual([1]);
	});

	it('carries the salt-window note explaining bounded retention depth', async () => {
		await seedSession('v', 0);
		const r = await cohortRetention(env, f, 'week');
		expect(r.note).toMatch(/salt window/i);
	});

	it('returns no cohorts when the range has no sessions', async () => {
		const r = await cohortRetention(env, f, 'week');
		expect(r.cohorts).toEqual([]);
		expect(r.note).toMatch(/salt window/i);
	});
});

describe('cohortRetention (day) and the salt-window reality', () => {
	it('reflects daily-window reality: a rotated hash across days is a new visitor, so cross-day retention is ~0', async () => {
		// Same PERSON on three consecutive days, but the daily salt rotation gives a different hash each
		// day. Each hash is its own single-day cohort of size 1 that never "returns".
		await seedSession('hash-day0', 0);
		await seedSession('hash-day1', 1);
		await seedSession('hash-day2', 2);

		const r = await cohortRetention(env, f, 'day');
		expect(r.cohorts).toHaveLength(3);
		for (const c of r.cohorts) {
			expect(c.size).toBe(1);
			// Only period 0 (the first day) is retained; no cross-day return.
			expect(c.retention).toEqual([1]);
		}
	});

	it('counts a within-window returning hash as retained across days', async () => {
		// A hash stable across days (wider salt window) DOES show cross-day retention.
		await seedSession('stable', 0);
		await seedSession('stable', 1);
		const r = await cohortRetention(env, f, 'day');
		const cohort = r.cohorts.find((c) => c.cohort === dayKey(0));
		expect(cohort?.size).toBe(1);
		expect(cohort?.retention).toEqual([1, 1]);
	});

	it('caps the matrix at 12 cohorts', async () => {
		// 20 distinct single-day cohorts; only the most recent 12 survive the cap.
		for (let d = 0; d < 20; d++) {
			await seedSession(`only-${d}`, d);
		}
		const r = await cohortRetention(env, f, 'day');
		expect(r.cohorts).toHaveLength(12);
		// The kept cohorts are the LAST 12 (days 8..19), ascending.
		expect(r.cohorts[0]?.cohort).toBe(dayKey(8));
		expect(r.cohorts.at(-1)?.cohort).toBe(dayKey(19));
	});
});
