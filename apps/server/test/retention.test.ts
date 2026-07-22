// Retention cleanup: only rows older than the cutoff are deleted; event_rollups untouched.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { enforceRetention } from '../src/lib/retention.js';

const S = '11111111-1111-4111-8111-111111111111';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1, 0, 0, 0, 0);
// RAW_RETENTION_DAYS is '90' in the test env; cutoff = NOW - 90d.
const OLD = NOW - 100 * DAY;
const FRESH = NOW - 10 * DAY;

async function count(sql: string, ...binds: unknown[]): Promise<number> {
	const row = await env.DB.prepare(sql)
		.bind(...binds)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe('enforceRetention', () => {
	it('deletes stale events/sessions/salts and preserves fresh rows and rollups', async () => {
		await env.DB.prepare(
			'INSERT INTO events (id, site_id, hostname, path, referrer, visitor_hash, created_at) VALUES (?,?,?,?,?,?,?)',
		)
			.bind('e-old', S, 'h', '/', '', 'v', OLD)
			.run();
		await env.DB.prepare(
			'INSERT INTO events (id, site_id, hostname, path, referrer, visitor_hash, created_at) VALUES (?,?,?,?,?,?,?)',
		)
			.bind('e-fresh', S, 'h', '/', '', 'v', FRESH)
			.run();
		await env.DB.prepare(
			'INSERT INTO sessions (site_id, visitor_hash, day_key, first_seen) VALUES (?,?,?,?)',
		)
			.bind(S, 'v', '2026-02-01', OLD)
			.run();
		await env.DB.prepare(
			'INSERT INTO sessions (site_id, visitor_hash, day_key, first_seen) VALUES (?,?,?,?)',
		)
			.bind(S, 'v', '2026-05-22', FRESH)
			.run();
		await env.DB.prepare('INSERT INTO salts (day_key, salt, created_at) VALUES (?,?,?)')
			.bind('2026-02-01', 'aa', OLD)
			.run();
		await env.DB.prepare('INSERT INTO salts (day_key, salt, created_at) VALUES (?,?,?)')
			.bind('2026-05-22', 'bb', FRESH)
			.run();
		await env.DB.prepare(
			'INSERT INTO event_rollups (site_id, hostname, bucket_start, interval, pageviews, events, visitors) VALUES (?,?,?,?,?,?,?)',
		)
			.bind(S, 'h', OLD, 'day', 5, 0, 3)
			.run();

		await enforceRetention(env, NOW);

		expect(await count('SELECT COUNT(*) AS n FROM events WHERE id = ?', 'e-old')).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM events WHERE id = ?', 'e-fresh')).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE first_seen = ?', OLD)).toBe(0);
		expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE first_seen = ?', FRESH)).toBe(
			1,
		);
		expect(await count('SELECT COUNT(*) AS n FROM salts WHERE day_key = ?', '2026-02-01')).toBe(
			0,
		);
		expect(await count('SELECT COUNT(*) AS n FROM salts WHERE day_key = ?', '2026-05-22')).toBe(
			1,
		);
		expect(await count('SELECT COUNT(*) AS n FROM event_rollups')).toBe(1);
	});

	it('purges identity salts by window END (not creation) and aged consent records', async () => {
		// A salt CREATED long ago but whose window has NOT yet closed must survive — proving the purge
		// keys on window_end, so a live event can never reference a purged salt.
		await env.DB.prepare(
			'INSERT INTO identity_salts (scope, salt, window, window_end, created_at) VALUES (?,?,?,?,?)',
		)
			.bind(`${S}:week:closed`, 'aa', 'week', OLD, OLD)
			.run();
		await env.DB.prepare(
			'INSERT INTO identity_salts (scope, salt, window, window_end, created_at) VALUES (?,?,?,?,?)',
		)
			.bind(`${S}:month:open`, 'bb', 'month', FRESH, OLD)
			.run();
		await env.DB.prepare(
			"INSERT INTO consent_records (id, site_id, visitor_hash, tier, salt_window, window_key, gpc_at_grant, granted_at, statement) VALUES (?,?,?,?,?,?,?,?,'{}')",
		)
			.bind('c-old', S, 'v', 'pseudonymous', 'week', 'w', 0, OLD)
			.run();
		await env.DB.prepare(
			"INSERT INTO consent_records (id, site_id, visitor_hash, tier, salt_window, window_key, gpc_at_grant, granted_at, statement) VALUES (?,?,?,?,?,?,?,?,'{}')",
		)
			.bind('c-fresh', S, 'v', 'pseudonymous', 'week', 'w', 0, FRESH)
			.run();

		await enforceRetention(env, NOW);

		expect(
			await count(
				'SELECT COUNT(*) AS n FROM identity_salts WHERE scope = ?',
				`${S}:week:closed`,
			),
		).toBe(0);
		// Created 100 days ago, but its window closes only 10 days ago -> still live -> survives.
		expect(
			await count(
				'SELECT COUNT(*) AS n FROM identity_salts WHERE scope = ?',
				`${S}:month:open`,
			),
		).toBe(1);
		expect(await count('SELECT COUNT(*) AS n FROM consent_records WHERE id = ?', 'c-old')).toBe(
			0,
		);
		expect(
			await count('SELECT COUNT(*) AS n FROM consent_records WHERE id = ?', 'c-fresh'),
		).toBe(1);
	});
});
