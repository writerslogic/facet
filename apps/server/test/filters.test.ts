// T021: buildEventWhere — the canonical site/hostname/[start,end) predicate over `events`.

import { env } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildEventWhere } from '../src/db/filters.js';
import { type NewEvent, db, insertEvent } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';

const S = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

const base: Omit<NewEvent, 'siteId' | 'hostname' | 'createdAt'> = {
	path: '/',
	referrer: '',
	name: null,
	props: null,
	visitorHash: 'v',
	country: null,
	device: null,
};

async function count(f: Parameters<typeof buildEventWhere>[0]): Promise<number> {
	const row = await db(env)
		.select({ c: sql<number>`COUNT(*)` })
		.from(schema.events)
		.where(buildEventWhere(f))
		.get();
	return Number(row?.c ?? 0);
}

beforeEach(async () => {
	await insertEvent(env, {
		...base,
		siteId: S,
		hostname: 'a.example.com',
		createdAt: T0,
	});
	await insertEvent(env, {
		...base,
		siteId: S,
		hostname: 'a.example.com',
		createdAt: T0 + 1000,
	});
	await insertEvent(env, {
		...base,
		siteId: S,
		hostname: 'b.example.com',
		createdAt: T0 + 2000,
	});
	await insertEvent(env, {
		...base,
		siteId: OTHER,
		hostname: 'a.example.com',
		createdAt: T0,
	});
});

describe('buildEventWhere', () => {
	it('filters by site', async () => {
		expect(await count({ siteId: S, start: T0 - 1, end: T0 + 10_000 })).toBe(3);
		expect(await count({ siteId: OTHER, start: T0 - 1, end: T0 + 10_000 })).toBe(1);
	});

	it('is inclusive of start and exclusive of end', async () => {
		expect(await count({ siteId: S, start: T0, end: T0 + 2000 })).toBe(2);
	});

	it('filters by hostname', async () => {
		expect(
			await count({
				siteId: S,
				hostname: 'a.example.com',
				start: T0 - 1,
				end: T0 + 10_000,
			}),
		).toBe(2);
		expect(
			await count({
				siteId: S,
				hostname: 'b.example.com',
				start: T0 - 1,
				end: T0 + 10_000,
			}),
		).toBe(1);
	});
});
