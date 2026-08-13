// Retention cleanup: only rows older than the cutoff are deleted; event_rollups untouched.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { DEFAULT_RAW_RETENTION_DAYS } from '../src/lib/constants.js';
import { enforceRetention, retentionDays } from '../src/lib/retention.js';

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

describe('retentionDays', () => {
	// Three callers read this window — the purge job, the signed privacy attestation, and the AE
	// mirror's gate. They only agree because they all come through here, so the contract is pinned.
	it('accepts a positive integer setting', () => {
		expect(retentionDays({ RAW_RETENTION_DAYS: '30' } as Env)).toBe(30);
		expect(retentionDays({ RAW_RETENTION_DAYS: '1' } as Env)).toBe(1);
	});

	it('falls back to the default for anything that is not one', () => {
		for (const bad of ['', '0', '-5', 'thirty', 'NaN', undefined]) {
			expect(retentionDays({ RAW_RETENTION_DAYS: bad } as unknown as Env)).toBe(
				DEFAULT_RAW_RETENTION_DAYS,
			);
		}
	});

	it('keeps parseInt’s leading-digit reading, so a suffixed value still floors correctly', () => {
		// "30days" → 30 is the intended tolerance; "1.5" → 1 falls out of the same rule, and both are
		// safe because the `>= 1` floor is what actually protects the cutoff.
		expect(retentionDays({ RAW_RETENTION_DAYS: '30days' } as Env)).toBe(30);
		expect(retentionDays({ RAW_RETENTION_DAYS: '1.5' } as Env)).toBe(1);
	});
});

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

	it('purges materialized visits on their FIRST event, so no summary outlives its events', async () => {
		// `event_sessions` is the second session table and the one that carries a visitor hash next to
		// entry path, exit path and duration. Three rows pin the key: aged out, inside the window, and
		// the straddler that decides `started_at` vs `ended_at` — it begins before the cutoff, so the
		// events it counted are being deleted in this same sweep and the aggregate must go with them.
		const insert = (id: string, startedAt: number, endedAt: number) =>
			env.DB.prepare(
				'INSERT INTO event_sessions (id, site_id, visitor_hash, day_key, started_at, ended_at, entry_path, exit_path, pageviews, events, duration_ms, is_bounce) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
			)
				.bind(id, S, 'v', '2026-02-01', startedAt, endedAt, '/in', '/out', 3, 1, 60_000, 0)
				.run();
		await insert('s-old', OLD, OLD + 60_000);
		await insert('s-fresh', FRESH, FRESH + 60_000);
		await insert('s-straddle', NOW - 90 * DAY - 1, NOW - 89 * DAY);

		await enforceRetention(env, NOW);

		expect(await count('SELECT COUNT(*) AS n FROM event_sessions WHERE id = ?', 's-old')).toBe(
			0,
		);
		expect(
			await count('SELECT COUNT(*) AS n FROM event_sessions WHERE id = ?', 's-straddle'),
		).toBe(0);
		expect(
			await count('SELECT COUNT(*) AS n FROM event_sessions WHERE id = ?', 's-fresh'),
		).toBe(1);
	});

	it('leaves no aged visitor hash behind in either session table', async () => {
		// The privacy claim, asserted on the column rather than the row: the retention window is a
		// promise about the hash itself, and a sweep that cleared one session table and not the other
		// would still count as "sessions purged" by row count alone.
		const hash = 'aged-visitor-hash';
		await env.DB.prepare(
			'INSERT INTO sessions (site_id, visitor_hash, day_key, first_seen) VALUES (?,?,?,?)',
		)
			.bind(S, hash, '2026-02-02', OLD)
			.run();
		await env.DB.prepare(
			'INSERT INTO event_sessions (id, site_id, visitor_hash, day_key, started_at, ended_at, entry_path, exit_path, pageviews, events, duration_ms, is_bounce) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
		)
			.bind('s-hash', S, hash, '2026-02-02', OLD, OLD + 1000, '/in', '/out', 1, 0, 1000, 1)
			.run();

		await enforceRetention(env, NOW);

		expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE visitor_hash = ?', hash)).toBe(
			0,
		);
		expect(
			await count('SELECT COUNT(*) AS n FROM event_sessions WHERE visitor_hash = ?', hash),
		).toBe(0);
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

	it('purges magic-link tokens on their own expiry, not the raw window', async () => {
		// The distinction under test. A token expired one minute ago is FRESH by the ninety-day raw
		// cutoff, so a sweep that reused `cutoff` here would keep it for another eighty-nine days —
		// along with the email address it carries — despite it having been unredeemable the whole time.
		await env.DB.prepare(
			'INSERT INTO auth_tokens (id, token_hash, email, expires_at, used_at, created_at) VALUES (?,?,?,?,?,?)',
		)
			.bind('t-expired', 'h1', 'expired@example.com', NOW - 60_000, null, FRESH)
			.run();
		await env.DB.prepare(
			'INSERT INTO auth_tokens (id, token_hash, email, expires_at, used_at, created_at) VALUES (?,?,?,?,?,?)',
		)
			.bind('t-live', 'h2', 'live@example.com', NOW + 60_000, null, NOW)
			.run();
		// Created before the raw cutoff and long dead, but the point is that expiry alone decides.
		await env.DB.prepare(
			'INSERT INTO auth_tokens (id, token_hash, email, expires_at, used_at, created_at) VALUES (?,?,?,?,?,?)',
		)
			.bind('t-ancient', 'h3', 'ancient@example.com', OLD, OLD, OLD)
			.run();

		await enforceRetention(env, NOW);

		expect(await count('SELECT COUNT(*) AS n FROM auth_tokens WHERE id = ?', 't-expired')).toBe(
			0,
		);
		expect(await count('SELECT COUNT(*) AS n FROM auth_tokens WHERE id = ?', 't-ancient')).toBe(
			0,
		);
		// An unexpired token is still redeemable, so purging it would break a link already in an inbox.
		expect(await count('SELECT COUNT(*) AS n FROM auth_tokens WHERE id = ?', 't-live')).toBe(1);
	});

	it('still purges salts/identity_salts when an earlier delete (events) fails', async () => {
		// The privacy-critical invariant under test: `events` runs first and is the table most likely to
		// hit a real D1 error, but its failure must never block the salt/identity-salt deletes below it —
		// those irreversibly sever the hash→input mapping the retention window promises. Simulate a
		// failure by dropping `events` out from under the delete (isolated per-test by apply-migrations.ts).
		await env.DB.prepare('INSERT INTO salts (day_key, salt, created_at) VALUES (?,?,?)')
			.bind('2026-02-01', 'aa', OLD)
			.run();
		await env.DB.prepare(
			'INSERT INTO identity_salts (scope, salt, window, window_end, created_at) VALUES (?,?,?,?,?)',
		)
			.bind(`${S}:week:closed`, 'aa', 'week', OLD, OLD)
			.run();
		await env.DB.exec('DROP TABLE events');

		await expect(enforceRetention(env, NOW)).rejects.toThrow(/purge statement.* failed/);

		expect(await count('SELECT COUNT(*) AS n FROM salts WHERE day_key = ?', '2026-02-01')).toBe(
			0,
		);
		expect(
			await count(
				'SELECT COUNT(*) AS n FROM identity_salts WHERE scope = ?',
				`${S}:week:closed`,
			),
		).toBe(0);
	});

	it('leaves no operator email behind once the tokens carrying it expire', async () => {
		// The privacy claim, asserted on the column rather than the row count: `auth_tokens.email` is
		// the only place a would-be operator's address is stored before they ever sign in, so a request
		// for an address that never became an account must leave nothing at all behind.
		await env.DB.prepare(
			'INSERT INTO auth_tokens (id, token_hash, email, expires_at, used_at, created_at) VALUES (?,?,?,?,?,?)',
		)
			.bind('t-never-used', 'h4', 'stranger@example.com', NOW - 1, null, FRESH)
			.run();

		await enforceRetention(env, NOW);

		expect(
			await count(
				'SELECT COUNT(*) AS n FROM auth_tokens WHERE email = ?',
				'stranger@example.com',
			),
		).toBe(0);
	});
});
