// Identity policy + scoped-salt store (U2). resolvePolicy is the single tier chokepoint: a site with
// no config is Tier 0, and — critically — any elevated tier clamps back to Tier 0 unless a deployment
// signing key is configured (the test env has none, so elevation must fail safe). getScopedSalt is
// stable per scope and records window_end for retention.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getScopedSalt, resolvePolicy, windowEndMs } from '../src/lib/identity.js';

const SITE = '55555555-5555-4555-8555-555555555555';

describe('windowEndMs', () => {
	it('is the exclusive end of the containing window', () => {
		const mid = Date.UTC(2026, 6, 15, 12); // Wed 2026-07-15
		expect(windowEndMs('day', mid)).toBe(Date.UTC(2026, 6, 16));
		expect(windowEndMs('month', mid)).toBe(Date.UTC(2026, 7, 1));
		// ISO week Mon 2026-07-13 .. end is Mon 2026-07-20 00:00.
		expect(windowEndMs('week', mid)).toBe(Date.UTC(2026, 6, 20));
	});
});

describe('resolvePolicy', () => {
	it('defaults to anonymous/day when no config row exists', async () => {
		expect(await resolvePolicy(env, SITE)).toEqual({
			tier: 'anonymous',
			window: 'day',
		});
	});

	it('clamps an elevated tier to anonymous when no signing key is configured', async () => {
		await env.DB.prepare(
			'INSERT OR REPLACE INTO site_config (site_id, tier, salt_window, updated_at) VALUES (?, ?, ?, ?)',
		)
			.bind(SITE, 'pseudonymous', 'week', Date.now())
			.run();
		// The test env has no FACET_SIGNING_JWK, so elevation must fail safe to Tier 0.
		expect(await resolvePolicy(env, SITE)).toEqual({
			tier: 'anonymous',
			window: 'day',
		});
	});

	it('clamps unknown stored values to anonymous', async () => {
		await env.DB.prepare(
			'INSERT OR REPLACE INTO site_config (site_id, tier, salt_window, updated_at) VALUES (?, ?, ?, ?)',
		)
			.bind(SITE, 'bogus', 'year', Date.now())
			.run();
		expect(await resolvePolicy(env, SITE)).toEqual({
			tier: 'anonymous',
			window: 'day',
		});
	});
});

describe('getScopedSalt', () => {
	it('is stable per scope and records the window end', async () => {
		const now = Date.UTC(2026, 6, 15, 12);
		const end = windowEndMs('week', now);
		const scope = `${SITE}:week:2026-W29`;
		const a = await getScopedSalt(env, scope, 'week', end, now);
		const b = await getScopedSalt(env, scope, 'week', end, now);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		const row = await env.DB.prepare(
			'SELECT window, window_end FROM identity_salts WHERE scope = ?',
		)
			.bind(scope)
			.first<{ window: string; window_end: number }>();
		expect(row).toEqual({ window: 'week', window_end: end });
	});
});
