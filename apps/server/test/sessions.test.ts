// Sessionization: consecutive events per visitor split into sessions on a >30-min gap;
// bounce detection; deterministic idempotent upsert.

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import { buildSessions } from '../src/lib/sessions.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-01-01';
const T0 = Date.parse(`${DAY}T00:00:00.000Z`);
const MIN = 60_000;

async function ev(opts: {
	visitor: string;
	path: string;
	name: string | null;
	channel: string | null;
	at: number;
	site?: string;
}): Promise<void> {
	await db(env)
		.insert(schema.events)
		.values({
			id: crypto.randomUUID(),
			siteId: opts.site ?? SITE,
			hostname: 'x.example.com',
			path: opts.path,
			referrer: '',
			name: opts.name,
			props: null,
			visitorHash: opts.visitor,
			country: 'US',
			device: 'desktop',
			createdAt: opts.at,
			channel: opts.channel,
		});
}

async function sessionRows() {
	return db(env).select().from(schema.eventSessions).orderBy(schema.eventSessions.startedAt);
}

describe('buildSessions', () => {
	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM events').run();
		await env.DB.prepare('DELETE FROM event_sessions').run();
	});

	it('splits a visitor into two sessions across a >30-min gap', async () => {
		await ev({
			visitor: 'v1',
			path: '/',
			name: null,
			channel: 'direct',
			at: T0,
		});
		await ev({
			visitor: 'v1',
			path: '/next',
			name: null,
			channel: 'direct',
			at: T0 + 40 * MIN,
		});

		const written = await buildSessions(env, DAY);
		expect(written).toBe(2);

		const rows = await sessionRows();
		expect(rows.length).toBe(2);
		expect(rows[0]?.startedAt).toBe(T0);
		expect(rows[0]?.entryPath).toBe('/');
		expect(rows[1]?.startedAt).toBe(T0 + 40 * MIN);
		expect(rows[1]?.entryPath).toBe('/next');
	});

	it('marks a single-pageview session as a bounce', async () => {
		await ev({
			visitor: 'v2',
			path: '/',
			name: null,
			channel: 'direct',
			at: T0,
		});

		await buildSessions(env, DAY);
		const rows = await sessionRows();
		expect(rows.length).toBe(1);
		expect(rows[0]?.isBounce).toBe(1);
		expect(rows[0]?.pageviews).toBe(1);
		expect(rows[0]?.durationMs).toBe(0);
	});

	it('computes multi-event sessions and channel/exit from the group', async () => {
		await ev({
			visitor: 'v3',
			path: '/',
			name: null,
			channel: 'organic',
			at: T0,
		});
		await ev({
			visitor: 'v3',
			path: '/a',
			name: null,
			channel: 'referral',
			at: T0 + 5 * MIN,
		});
		await ev({
			visitor: 'v3',
			path: '/a',
			name: 'signup',
			channel: 'direct',
			at: T0 + 6 * MIN,
		});

		await buildSessions(env, DAY);
		const rows = await sessionRows();
		expect(rows.length).toBe(1);
		const s = rows[0];
		expect(s?.pageviews).toBe(2);
		expect(s?.events).toBe(1);
		expect(s?.entryPath).toBe('/');
		expect(s?.exitPath).toBe('/a');
		expect(s?.channel).toBe('organic');
		expect(s?.isBounce).toBe(0);
		expect(s?.durationMs).toBe(6 * MIN);
	});

	it('merges a session that spans midnight instead of splitting or double-counting it', async () => {
		// A chain of sub-timeout gaps (20/25/20 min) starting the evening before DAY, so the true
		// session start is further back than a single SESSION_TIMEOUT_MS lookback would reach.
		const PREV_DAY = '2025-12-31';
		const at = [T0 - 60 * MIN, T0 - 40 * MIN, T0 - 15 * MIN, T0 + 5 * MIN];
		for (const [i, ts] of at.entries()) {
			await ev({ visitor: 'spanner', path: `/p${i}`, name: null, channel: 'direct', at: ts });
		}

		// Simulate the real cron order: the previous day's own run happens first (writing a truncated
		// view), then this day's run, which must correct it in place rather than add a second row.
		await buildSessions(env, PREV_DAY);
		const written = await buildSessions(env, DAY);
		expect(written).toBe(1);

		const rows = await sessionRows();
		expect(rows.length).toBe(1);
		expect(rows[0]?.startedAt).toBe(at[0]);
		expect(rows[0]?.dayKey).toBe(PREV_DAY);
		expect(rows[0]?.pageviews).toBe(4);
		expect(rows[0]?.entryPath).toBe('/p0');
		expect(rows[0]?.exitPath).toBe('/p3');
	});

	it('is idempotent — re-running yields identical rows', async () => {
		await ev({
			visitor: 'v1',
			path: '/',
			name: null,
			channel: 'direct',
			at: T0,
		});
		await ev({
			visitor: 'v1',
			path: '/next',
			name: null,
			channel: 'direct',
			at: T0 + 40 * MIN,
		});

		await buildSessions(env, DAY);
		const first = await sessionRows();
		await buildSessions(env, DAY);
		const second = await sessionRows();

		expect(second.length).toBe(first.length);
		expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
		expect(second).toEqual(first);
	});

	it('sessionizes each site independently, never merging visitors across sites', async () => {
		// Same visitor hash reused across two sites, events interleaved in time. Sessionization is
		// scoped per site_id (each site's own query), so this must never group across the site boundary.
		await ev({
			visitor: 'shared',
			path: '/a',
			name: null,
			channel: 'direct',
			at: T0,
			site: SITE,
		});
		await ev({
			visitor: 'shared',
			path: '/b',
			name: null,
			channel: 'organic',
			at: T0 + 1 * MIN,
			site: SITE_B,
		});
		await ev({
			visitor: 'shared',
			path: '/a2',
			name: null,
			channel: 'direct',
			at: T0 + 2 * MIN,
			site: SITE,
		});

		const written = await buildSessions(env, DAY);
		expect(written).toBe(2);

		const rows = await sessionRows();
		expect(rows.length).toBe(2);
		const bySite = new Map(rows.map((r) => [r.siteId, r]));
		expect(bySite.get(SITE)?.pageviews).toBe(2);
		expect(bySite.get(SITE)?.entryPath).toBe('/a');
		expect(bySite.get(SITE)?.exitPath).toBe('/a2');
		expect(bySite.get(SITE_B)?.pageviews).toBe(1);
		expect(bySite.get(SITE_B)?.entryPath).toBe('/b');
	});

	it('a failure in every site is attempted and every failure reported, not just the first', async () => {
		await ev({ visitor: 'v1', path: '/', name: null, channel: 'direct', at: T0, site: SITE });
		await ev({ visitor: 'v1', path: '/', name: null, channel: 'direct', at: T0, site: SITE_B });

		// Forces every site's own insert to fail (isolated per-test by apply-migrations.ts) — proves the
		// per-site loop attempts all sites and aggregates every failure rather than aborting on the first.
		await env.DB.exec('DROP TABLE event_sessions');

		await expect(buildSessions(env, DAY)).rejects.toThrow(/failed for 2 of 2 site/);
	});

	it('one site failing does not block another site from being written', async () => {
		await ev({ visitor: 'v1', path: '/', name: null, channel: 'direct', at: T0, site: SITE });
		await ev({ visitor: 'v1', path: '/', name: null, channel: 'direct', at: T0, site: SITE_B });

		// Fails only SITE's insert, deterministically, without touching SITE_B's — a real per-row DB
		// failure, not a mock, so this proves the isolation the refactor exists for rather than just
		// that errors get aggregated.
		await env.DB.exec(
			`CREATE TRIGGER fail_site_a BEFORE INSERT ON event_sessions WHEN NEW.site_id = '${SITE}' BEGIN SELECT RAISE(ABORT, 'forced failure for site A'); END`,
		);

		await expect(buildSessions(env, DAY)).rejects.toThrow(/failed for 1 of 2 site/);

		const rows = await sessionRows();
		expect(rows.length).toBe(1);
		expect(rows[0]?.siteId).toBe(SITE_B);
		expect(rows[0]?.entryPath).toBe('/');
	});
});
