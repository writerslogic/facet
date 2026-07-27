// Account auth: session-token crypto + role ranking (pure), the magic-link lifecycle + user/team
// bootstrap (D1), and the request→verify→me route flow.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
	consumeMagicToken,
	createMagicToken,
	isRole,
	roleAtLeast,
	signSession,
	upsertUserByEmail,
	userMemberships,
	verifySession,
} from '../src/lib/accounts.js';

const SECRET = 'unit-secret';

describe('session tokens', () => {
	it('round-trips a valid session', async () => {
		const t = await signSession('user-1', SECRET, 1_000_000);
		expect((await verifySession(t, SECRET, 1_001_000))?.sub).toBe('user-1');
	});
	it('rejects tampering, a wrong secret, and expiry', async () => {
		const t = await signSession('user-1', SECRET, 0);
		expect(await verifySession(`${t}x`, SECRET, 1)).toBeNull();
		expect(await verifySession(t, 'wrong', 1)).toBeNull();
		expect(await verifySession(t, SECRET, 40 * 24 * 60 * 60 * 1000)).toBeNull();
	});
});

describe('roles', () => {
	it('ranks owner ▸ admin ▸ analyst ▸ viewer', () => {
		expect(roleAtLeast('owner', 'admin')).toBe(true);
		expect(roleAtLeast('analyst', 'admin')).toBe(false);
		expect(roleAtLeast('admin', 'admin')).toBe(true);
		expect(isRole('viewer')).toBe(true);
		expect(isRole('root')).toBe(false);
	});
});

describe('magic-link lifecycle', () => {
	it('is single-use and bootstraps a personal team with an owner membership', async () => {
		const email = 'lifecycle@example.com';
		const now = Date.now();
		const token = await createMagicToken(env, email, now);
		expect(await consumeMagicToken(env, token, now + 1000)).toBe(email);
		// Second use is rejected.
		expect(await consumeMagicToken(env, token, now + 2000)).toBeNull();
		// A bad token is rejected.
		expect(await consumeMagicToken(env, 'nope.nope', now)).toBeNull();

		const user = await upsertUserByEmail(env, email, now);
		const again = await upsertUserByEmail(env, email, now + 5000);
		expect(again.id).toBe(user.id); // idempotent, no duplicate user
		const memberships = await userMemberships(env, user.id);
		expect(memberships).toHaveLength(1);
		expect(memberships[0]?.role).toBe('owner');
	});
});

describe('POST /api/auth/verify → GET /api/auth/me', () => {
	it('exchanges a magic token for a session cookie and returns the user + role', async () => {
		const app = createApp();
		const email = 'flow@example.com';
		const token = await createMagicToken(env, email, Date.now());
		const verifyRes = await app.request(
			'/api/auth/verify',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token }),
			},
			env,
		);
		expect(verifyRes.status).toBe(200);
		const cookie = verifyRes.headers.get('set-cookie') ?? '';
		expect(cookie).toContain('facet_session=');
		expect(cookie.toLowerCase()).toContain('httponly');

		const meRes = await app.request(
			'/api/auth/me',
			{ headers: { cookie: cookie.split(';')[0] as string } },
			env,
		);
		expect(meRes.status).toBe(200);
		const me = (await meRes.json()) as {
			user: { email: string };
			memberships: { role: string }[];
		};
		expect(me.user.email).toBe(email);
		expect(me.memberships[0]?.role).toBe('owner');
	});

	it('rejects an invalid token with 401', async () => {
		const res = await createApp().request(
			'/api/auth/verify',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: 'bogus.token' }),
			},
			env,
		);
		expect(res.status).toBe(401);
	});
});

describe('POST /api/auth/admin-link (self-hosted bootstrap, no email)', () => {
	it('mints a usable magic link for an admin, and rejects non-admins', async () => {
		const app = createApp();
		const email = 'bootstrap@example.com';
		const noAuth = await app.request(
			'/api/auth/admin-link',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email }),
			},
			env,
		);
		expect(noAuth.status).toBe(401);

		const res = await app.request(
			'/api/auth/admin-link',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					Authorization: 'Bearer test-admin-token',
				},
				body: JSON.stringify({ email }),
			},
			env,
		);
		expect(res.status).toBe(200);
		const { token } = (await res.json()) as { token: string };
		// The minted token drives the normal verify flow — no email needed.
		const verifyRes = await app.request(
			'/api/auth/verify',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token }),
			},
			env,
		);
		expect(verifyRes.status).toBe(200);
	});
});
