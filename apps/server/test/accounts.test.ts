// Account auth: session-token crypto + role ranking (pure), the magic-link lifecycle + user/team
// bootstrap (D1), and the request→verify→me route flow.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
	SESSION_COOKIE,
	consumeMagicToken,
	createMagicToken,
	isRole,
	revokeSessions,
	roleAtLeast,
	signSession,
	upsertUserByEmail,
	userMemberships,
	verifySession,
} from '../src/lib/accounts.js';

const SECRET = 'unit-secret';

describe('session tokens', () => {
	it('round-trips a valid session', async () => {
		const t = await signSession('user-1', SECRET, 1_000_000, 0);
		expect((await verifySession(t, SECRET, 1_001_000))?.sub).toBe('user-1');
	});
	it('rejects tampering, a wrong secret, and expiry', async () => {
		const t = await signSession('user-1', SECRET, 0, 0);
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

	it('allows only one winner when the same token is consumed concurrently', async () => {
		const email = 'race@example.com';
		const now = Date.now();
		const token = await createMagicToken(env, email, now);
		const results = await Promise.all([
			consumeMagicToken(env, token, now + 1),
			consumeMagicToken(env, token, now + 1),
		]);
		expect(results.filter((result) => result === email)).toHaveLength(1);
		expect(results.filter((result) => result === null)).toHaveLength(1);
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

describe('requireSiteAccess (session RBAC on /api/stats)', () => {
	it('lets a team member read their site and blocks non-members', async () => {
		const now = Date.now();
		const secret = env.SESSION_SECRET as string;
		const app = createApp();
		const siteId = '10101010-1010-4010-8010-101010101010';
		const q = `?site_id=${siteId}&start=${now - 86_400_000}&end=${now}`;

		// A member of the team that owns the site can read it via a session cookie (no API key).
		const member = await upsertUserByEmail(env, 'member@example.com', now);
		const teamId = (await userMemberships(env, member.id))[0]?.teamId as string;
		await env.DB.prepare(
			'INSERT OR REPLACE INTO sites (id, name, domain, created_at, team_id) VALUES (?, ?, ?, ?, ?)',
		)
			.bind(siteId, 'S', 's.test', now, teamId)
			.run();
		const memberCookie = `${SESSION_COOKIE}=${await signSession(member.id, secret, now, member.sessionEpoch)}`;
		const ok = await app.request(`/api/stats${q}`, { headers: { cookie: memberCookie } }, env);
		expect(ok.status).toBe(200);

		// A user with no membership on this site's team is blocked.
		const outsider = await upsertUserByEmail(env, 'outsider@example.com', now);
		const outsiderCookie = `${SESSION_COOKIE}=${await signSession(outsider.id, secret, now, outsider.sessionEpoch)}`;
		const blocked = await app.request(
			`/api/stats${q}`,
			{ headers: { cookie: outsiderCookie } },
			env,
		);
		expect(blocked.status).toBe(401);
	});
});

// Session revocation. A session token is HMAC-signed and self-contained, so nothing about the token
// itself can be withdrawn once it is out — /logout clears a cookie in one browser and leaves a copied
// token valid for the rest of its thirty days. The epoch is what makes it withdrawable, and these are
// the four properties that have to hold for it to mean anything.
describe('revoking sessions', () => {
	const app = createApp();
	const secret = env.SESSION_SECRET as string;

	/** A live session cookie for a fresh operator. */
	async function signedIn(email: string): Promise<{ id: string; cookie: string }> {
		const now = Date.now();
		const user = await upsertUserByEmail(env, email, now);
		return {
			id: user.id,
			cookie: `${SESSION_COOKIE}=${await signSession(user.id, secret, now, user.sessionEpoch)}`,
		};
	}

	const me = (cookie: string) => app.request('/api/auth/me', { headers: { cookie } }, env);

	it('ends every outstanding session at once, not just the one that asked', async () => {
		const user = await signedIn('two-devices@example.com');
		// A second token for the same person: the other browser, or the copy someone took.
		const other = `${SESSION_COOKIE}=${await signSession(user.id, secret, Date.now(), 0)}`;
		expect((await me(user.cookie)).status).toBe(200);
		expect((await me(other)).status).toBe(200);

		const res = await app.request(
			'/api/auth/logout-everywhere',
			{ method: 'POST', headers: { cookie: user.cookie } },
			env,
		);
		expect(res.status).toBe(204);
		// The point of the whole design: the token this request never saw is dead too.
		expect((await me(other)).status).toBe(401);
		expect((await me(user.cookie)).status).toBe(401);
		// And the browser that asked is not left holding a session it believes in.
		expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=;`);
	});

	it('leaves everyone else signed in', async () => {
		// Revocation is per user. A shared epoch would make one person's stolen laptop everybody's
		// forced sign-in.
		const alice = await signedIn('alice@example.com');
		const bob = await signedIn('bob@example.com');
		await app.request(
			'/api/auth/logout-everywhere',
			{ method: 'POST', headers: { cookie: alice.cookie } },
			env,
		);
		expect((await me(alice.cookie)).status).toBe(401);
		expect((await me(bob.cookie)).status).toBe(200);
	});

	it('signs the next session in at the new epoch, so revocation is not permanent', async () => {
		const user = await signedIn('again@example.com');
		await revokeSessions(env, user.id);
		expect((await me(user.cookie)).status).toBe(401);

		// Signing back in must work. An epoch read at mint time that went stale would lock the account
		// out of itself — revocation has to end the old sessions, not the ability to have one.
		const token = await createMagicToken(env, 'again@example.com', Date.now());
		const verified = await app.request(
			'/api/auth/verify',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token }),
			},
			env,
		);
		expect(verified.status).toBe(200);
		const fresh = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
		expect((await me(fresh)).status).toBe(200);
		// The old one stays dead: signing in again does not resurrect what was revoked.
		expect((await me(user.cookie)).status).toBe(401);
	});

	it('refuses a token that carries no epoch at all', async () => {
		// What a session minted before revocation existed looks like. It cannot be compared against a
		// revocation, and an unverifiable revocation state has to read as revoked.
		const body = btoa(JSON.stringify({ sub: 'anyone', exp: Date.now() + 60_000 }))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const sig = new Uint8Array(
			await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
		);
		const legacy = `${body}.${btoa(String.fromCharCode(...sig))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '')}`;
		// Genuinely signed by this deployment — it fails on the missing claim, not on the signature.
		expect(await verifySession(legacy, secret, Date.now())).toBeNull();
	});

	it('ends the sessions of a user whose account is deleted', async () => {
		const user = await signedIn('deleted@example.com');
		expect((await me(user.cookie)).status).toBe(200);
		await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
		// There is no epoch to compare against, and an account that does not exist holds no sessions.
		expect((await me(user.cookie)).status).toBe(401);
	});

	it('reports nothing to revoke for an unknown user', async () => {
		expect(await revokeSessions(env, 'no-such-user')).toBe(false);
	});
});

describe('account bootstrap', () => {
	it('never leaves a user without the team that makes them reachable', async () => {
		// The three inserts are one batch, which for D1 is one transaction. Split apart, a failure
		// between them strands a user who can never gain a team — every later login takes the
		// `existing` branch and returns early, so nothing repairs it and the users table still looks
		// healthy. This pins the invariant rather than the statement count: a refactor that drops the
		// membership insert fails here.
		const user = await upsertUserByEmail(env, 'bootstrap@example.com', Date.now());
		const memberships = await userMemberships(env, user.id);
		expect(memberships).toHaveLength(1);
		expect(memberships[0]?.role).toBe('owner');
		// And the team the membership names actually exists, rather than pointing at nothing.
		const team = await env.DB.prepare('SELECT id FROM teams WHERE id = ?')
			.bind(memberships[0]?.teamId)
			.first<{ id: string }>();
		expect(team?.id).toBe(memberships[0]?.teamId);
	});
});

describe('admin session revocation', () => {
	const app = createApp();

	it('ends a named operator’s sessions, which is the lever the audit log points at', async () => {
		// The log names the operator whose session read the contact table. Before this route the only
		// person who could act on that was the operator themselves — the wrong person entirely when
		// the question is whether their session was stolen.
		const now = Date.now();
		const user = await upsertUserByEmail(env, 'suspect@example.com', now);
		const secret = env.SESSION_SECRET as string;
		const cookie = `${SESSION_COOKIE}=${await signSession(user.id, secret, now, user.sessionEpoch)}`;
		expect((await app.request('/api/auth/me', { headers: { cookie } }, env)).status).toBe(200);

		const res = await app.request(
			`/api/users/${user.id}/revoke-sessions`,
			{ method: 'POST', headers: { Authorization: 'Bearer test-admin-token' } },
			env,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ user_id: user.id, sessions_revoked: true });
		expect((await app.request('/api/auth/me', { headers: { cookie } }, env)).status).toBe(401);
	});

	it('404s an unknown user rather than reporting a revocation that never happened', async () => {
		const res = await app.request(
			'/api/users/no-such-user/revoke-sessions',
			{ method: 'POST', headers: { Authorization: 'Bearer test-admin-token' } },
			env,
		);
		expect(res.status).toBe(404);
	});

	it('refuses without the admin token, so it is not a session-authenticated route', async () => {
		const now = Date.now();
		const user = await upsertUserByEmail(env, 'notadmin@example.com', now);
		const secret = env.SESSION_SECRET as string;
		const cookie = `${SESSION_COOKIE}=${await signSession(user.id, secret, now, user.sessionEpoch)}`;
		// A team role is not enough and a session cookie is not a credential here.
		const res = await app.request(
			`/api/users/${user.id}/revoke-sessions`,
			{ method: 'POST', headers: { cookie } },
			env,
		);
		expect(res.status).toBe(401);
		// And the session it tried to revoke is untouched.
		expect((await app.request('/api/auth/me', { headers: { cookie } }, env)).status).toBe(200);
	});
});
