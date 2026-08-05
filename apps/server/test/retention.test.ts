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
