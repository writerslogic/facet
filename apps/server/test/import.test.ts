// POST /api/import: admin-only historical backfill. Covers the invariants the route exists to hold —
// backdated rows are readable through /api/stats, a re-import is a no-op, and a range the retention
// cron would delete is refused rather than accepted and silently purged.

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { issueKey } from '../src/lib/apikeys.js';
import { DAY_MS } from '../src/lib/constants.js';
import { enforceRetention } from '../src/lib/retention.js';

const ADMIN = 'Bearer test-admin-token';
const JSON_HEADERS = { Authorization: ADMIN, 'content-type': 'application/json' };

let siteId: string;
let apiKey: string;
let day: number;

interface ImportBody {
	imported: number;
	skipped: number;
	duplicates: number;
	days: string[];
	note: string;
}

function post(body: unknown, headers: Record<string, string> = JSON_HEADERS) {
	return createApp().request(
		'/api/import',
		{ method: 'POST', headers, body: JSON.stringify(body) },
		env,
	);
}

function event(overrides: Record<string, unknown> = {}) {
	return {
		timestamp: day,
		visitor_id: 'src-visitor-1',
		hostname: 'legacy.example.com',
		path: '/',
		...overrides,
	};
}

async function importEvents(events: unknown[]): Promise<{ status: number; body: ImportBody }> {
	const res = await post({ site_id: siteId, events });
	return { status: res.status, body: (await res.json()) as ImportBody };
}

function stats(start: number, end: number) {
	return createApp().request(
		`/api/stats?site_id=${siteId}&start=${start}&end=${end}`,
		{ headers: { Authorization: `Bearer ${apiKey}` } },
		env,
	);
}

beforeEach(async () => {
	const res = await createApp().request(
		'/api/sites',
		{
			method: 'POST',
			headers: JSON_HEADERS,
			body: JSON.stringify({ name: 'Legacy', domain: 'legacy.example.com' }),
		},
		env,
	);
	siteId = ((await res.json()) as { site: { id: string } }).site.id;
	apiKey = (await issueKey(env, siteId, null, Date.now())).key;
	// Three days back: comfortably inside retention, and a whole UTC day in the past so the range the
	// assertions query is closed.
	day = Date.now() - 3 * DAY_MS;
});

describe('POST /api/import', () => {
	it('backfills history that /api/stats then reports over the imported range', async () => {
		const { status, body } = await importEvents([
			event({ path: '/', visitor_id: 'a' }),
			event({ path: '/pricing', visitor_id: 'a', timestamp: day + 60_000 }),
			event({ path: '/', visitor_id: 'b', timestamp: day + 120_000 }),
			event({ name: 'signup', visitor_id: 'b', timestamp: day + 180_000 }),
		]);
		expect(status).toBe(200);
		expect(body).toMatchObject({ imported: 4, skipped: 0 });

		const res = await stats(day - DAY_MS, day + DAY_MS);
		expect(res.status).toBe(200);
		const stat = (await res.json()) as {
			summary: { pageviews: number; events: number; visitors: number };
			top_paths: { key: string; count: number }[];
		};
		expect(stat.summary).toEqual({ pageviews: 3, events: 1, visitors: 2 });
		// '/' carries 3 rows: two pageviews plus the `signup` event, which defaults to the same path.
		expect(stat.top_paths).toContainEqual({ key: '/', count: 3 });

		// The cron only sessionizes the day that just closed, so a backfilled day reaches
		// `event_sessions` only because the route rebuilds it.
		const sessions = await env.DB.prepare(
			'SELECT COUNT(*) AS n FROM event_sessions WHERE site_id = ?',
		)
			.bind(siteId)
			.first<{ n: number }>();
		expect(sessions?.n).toBe(2);
		const rollups = await env.DB.prepare(
			"SELECT pageviews FROM event_rollups WHERE site_id = ? AND interval = 'day'",
		)
			.bind(siteId)
			.first<{ pageviews: number }>();
		expect(rollups?.pageviews).toBe(3);
	});

	it('is idempotent: re-importing the same file adds no rows', async () => {
		const events = [
			event({ visitor_id: 'a' }),
			event({ visitor_id: 'b', timestamp: day + 5000 }),
		];
		await importEvents(events);
		const second = await importEvents(events);
		expect(second.body.imported).toBe(2);
		const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE site_id = ?')
			.bind(siteId)
			.first<{ n: number }>();
		expect(count?.n).toBe(2);
	});

	it('refuses to rewrite a daily rollup already committed to the transparency log', async () => {
		const start = Date.parse(`${new Date(day).toISOString().slice(0, 10)}T00:00:00.000Z`);
		await env.DB.prepare(
			'INSERT INTO mmr_leaves (leaf_no, node_index, rollup_key, leaf_hash) VALUES (?, ?, ?, ?)',
		)
			.bind(0, 0, `${siteId}|legacy.example.com|${start}|day`, '00'.repeat(32))
			.run();

		const res = await post({ site_id: siteId, events: [event()] });
		expect(res.status).toBe(409);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: 'signed_history_conflict',
		});
		const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE site_id = ?')
			.bind(siteId)
			.first<{ n: number }>();
		expect(count?.n).toBe(0);
	});

	// Regression: `isBot('')` is true, so an import carrying no user-agents would otherwise be dropped
	// in full and reported as a successful import of nothing.
	it('keeps rows that carry no user-agent, and still drops a declared bot', async () => {
		const { body } = await importEvents([
			event({ visitor_id: 'a' }),
			event({ visitor_id: 'b', timestamp: day + 1000, user_agent: 'Googlebot/2.1' }),
		]);
		expect(body).toMatchObject({ imported: 1, skipped: 1 });
	});

	it('collapses a row duplicated inside one batch instead of counting it imported', async () => {
		const { body } = await importEvents([
			event({ visitor_id: 'a' }),
			event({ visitor_id: 'a' }),
		]);
		expect(body).toMatchObject({ imported: 1, skipped: 0, duplicates: 1 });
	});

	// The other half of the retention boundary: the route's cutoff and `enforceRetention`'s cutoff must
	// agree, or an accepted import is deleted by the next cron run. Also pins the salt's `created_at`,
	// which is the imported day's own midnight so the salt never outlives the events it protects.
	it('keeps an accepted near-boundary row through a retention run', async () => {
		const old = Date.now() - 88 * DAY_MS;
		const { status } = await importEvents([event({ timestamp: old, visitor_id: 'a' })]);
		expect(status).toBe(200);

		await enforceRetention(env, Date.now());

		const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE site_id = ?')
			.bind(siteId)
			.first<{ n: number }>();
		expect(remaining?.n).toBe(1);
		const salt = await env.DB.prepare('SELECT COUNT(*) AS n FROM salts WHERE day_key = ?')
			.bind(new Date(old).toISOString().slice(0, 10))
			.first<{ n: number }>();
		expect(salt?.n).toBe(1);
	});

	it('refuses a range the retention cron would delete', async () => {
		const res = await post({
			site_id: siteId,
			events: [event({ timestamp: Date.now() - 100 * DAY_MS })],
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: 'out_of_retention',
		});
	});

	it('refuses a future timestamp and an unknown site', async () => {
		const future = await post({
			site_id: siteId,
			events: [event({ timestamp: Date.now() + DAY_MS })],
		});
		expect(future.status).toBe(400);
		const unknown = await post({
			site_id: '11111111-1111-4111-8111-111111111111',
			events: [event()],
		});
		expect(unknown.status).toBe(404);
	});

	it('rejects a write-scoped API key: backfill is admin-only', async () => {
		const res = await post(
			{ site_id: siteId, events: [event()] },
			{ Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
		);
		expect(res.status).toBe(401);
	});
});
