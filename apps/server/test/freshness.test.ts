// A.5: session-derived analytics carry freshness metadata. `pending` is true when raw events exist
// in the range but no sessions are materialized yet; false for empty ranges and materialized ones.
// The stats endpoints expose it as a backward-compatible optional `meta` field.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { sessionFreshness } from '../src/db/stats.js';
import { issueKey } from '../src/lib/apikeys.js';
import { dayKey } from '../src/lib/salt.js';
import { buildSessions } from '../src/lib/sessions.js';

const SITE = '88888888-8888-4888-8888-888888888888';
const DAY = Date.UTC(2026, 2, 10, 0, 0, 0, 0);
const F = { siteId: SITE, start: DAY, end: DAY + 86_400_000 };

function mk(i: number): NewEvent {
	return {
		siteId: SITE,
		hostname: 'x.example.com',
		path: '/',
		referrer: '',
		name: null,
		props: null,
		visitorHash: `v${i}`,
		country: 'US',
		device: 'desktop',
		createdAt: DAY + 3_600_000 + i * 1000,
	};
}

describe('sessionFreshness', () => {
	it('is not pending for an empty range', async () => {
		const f = await sessionFreshness(env, {
			siteId: SITE,
			start: 0,
			end: 1,
		});
		expect(f).toEqual({ materialization: 'hourly', pending: false });
	});

	it('is pending when raw events exist but sessions are not materialized', async () => {
		await insertEvent(env, mk(0));
		await insertEvent(env, mk(1));
		const f = await sessionFreshness(env, F);
		expect(f).toEqual({ materialization: 'hourly', pending: true });
	});

	it('is not pending once sessions are materialized', async () => {
		await insertEvent(env, mk(0));
		await buildSessions(env, dayKey(DAY + 3_600_000));
		const f = await sessionFreshness(env, F);
		expect(f.pending).toBe(false);
	});
});

describe('freshness in responses', () => {
	it('includes a backward-compatible meta field on GET /api/stats', async () => {
		const key = (await issueKey(env, SITE, null, Date.now())).key;
		await insertEvent(env, mk(0));
		const res = await createApp().request(
			`/api/stats?site_id=${SITE}&start=${F.start}&end=${F.end}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			meta?: { materialization: string; pending: boolean };
		};
		expect(body.meta?.materialization).toBe('hourly');
		expect(body.meta?.pending).toBe(true);
	});
});
