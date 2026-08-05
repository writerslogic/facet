// Passwordless account auth (Phase 4). POST /request issues a single-use magic-link token; POST /verify
// exchanges it for an HMAC-signed session cookie; GET /me returns the signed-in user + team roles; POST
// /logout clears the cookie. All account auth is gated on SESSION_SECRET — absent, these return 503 and
// the per-site API-key path (beacon, programmatic stats) is entirely unaffected.
//
// /logout and /logout-everywhere are not two spellings of one thing. A session token is HMAC-signed and
// self-contained, so deleting the cookie ends the session in THAT browser and does nothing to a token
// already copied out of it — which stays valid for the rest of its thirty days. Only the second route
// withdraws a token that is already out, by moving the user past the epoch every one of them carries.

import { vValidator } from '@hono/valibot-validator';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as v from 'valibot';
import type { AppEnv } from '../env.js';
import {
	SESSION_COOKIE,
	consumeMagicToken,
	createMagicToken,
	revokeSessions,
	sessionUser,
	signSession,
	upsertUserByEmail,
	userMemberships,
} from '../lib/accounts.js';
import { requireAdmin } from '../lib/auth.js';
import { ApiError, validationErrorHook } from '../lib/http.js';

export const authRoutes = new Hono<AppEnv>();

const RequestSchema = v.object({
	email: v.pipe(v.string(), v.email(), v.maxLength(254)),
});
const VerifySchema = v.object({
	token: v.pipe(v.string(), v.minLength(3), v.maxLength(200)),
});

function requireSecret(env: AppEnv['Bindings']): string {
	if (!env.SESSION_SECRET) {
		throw new ApiError('auth_unavailable', 503, 'account auth is not configured');
	}
	return env.SESSION_SECRET;
}

// Request a magic link. Always 202 (never reveals whether the email has an account). The link the user
// clicks is `${origin}/api/auth/verify?token=<token>`; delivery by email is a deployment concern (bind a
// Cloudflare Email sender). The token itself is created here regardless.
authRoutes.post('/request', vValidator('json', RequestSchema, validationErrorHook), async (c) => {
	requireSecret(c.env);
	await createMagicToken(c.env, c.req.valid('json').email, Date.now());
	return c.body(null, 202);
});

// Fully self-hosted bootstrap / invite: an operator holding ADMIN_TOKEN mints a magic link directly and
// gets it back in the response (safe — the caller is trusted). This means a self-hoster needs NO email or
// external service to sign in or invite teammates; email delivery of /request links is a pure convenience.
authRoutes.post(
	'/admin-link',
	requireAdmin,
	vValidator('json', RequestSchema, validationErrorHook),
	async (c) => {
		requireSecret(c.env);
		const email = c.req.valid('json').email;
		const token = await createMagicToken(c.env, email, Date.now());
		const link = `${new URL(c.req.url).origin}/login?token=${encodeURIComponent(token)}`;
		return c.json({ email, token, link });
	},
);

// Exchange a magic-link token for a session cookie. Accepts the token in the JSON body (SPA) or a `token`
// query param (direct link click).
authRoutes.post('/verify', vValidator('json', VerifySchema, validationErrorHook), async (c) => {
	const secret = requireSecret(c.env);
	const now = Date.now();
	const email = await consumeMagicToken(c.env, c.req.valid('json').token, now);
	if (!email) {
		throw new ApiError('invalid_token', 401, 'the link is invalid, used, or expired');
	}
	const user = await upsertUserByEmail(c.env, email, now);
	const session = await signSession(user.id, secret, now, user.sessionEpoch);
	setCookie(c, SESSION_COOKIE, session, {
		httpOnly: true,
		secure: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: 30 * 24 * 60 * 60,
	});
	return c.json({ user });
});

// The signed-in user and their team roles, or 401.
authRoutes.get('/me', async (c) => {
	const secret = requireSecret(c.env);
	// `sessionUser` reads the row it verifies against, so describing the operator costs nothing beyond
	// the check itself — this route spends the same one query it did before the epoch existed.
	const user = await sessionUser(c.env, getCookie(c, SESSION_COOKIE), secret, Date.now());
	if (!user) {
		throw new ApiError('unauthenticated', 401);
	}
	return c.json({ user, memberships: await userMemberships(c.env, user.id) });
});

authRoutes.post('/logout', (c) => {
	deleteCookie(c, SESSION_COOKIE, { path: '/' });
	return c.body(null, 204);
});

/**
 * End every session this operator holds, anywhere — the one thing `/logout` cannot do.
 *
 * `/logout` deletes a cookie in the browser that asked. It does nothing to a token already copied out
 * of that browser, which stays valid for the rest of its thirty days; for a session someone suspects
 * has been stolen, clearing the cookie is not a remedy at all. This moves the user's epoch past the
 * one every outstanding token carries, so all of them stop resolving at once — including the one
 * making this request, whose cookie is cleared too so the browser is not left holding a dead session
 * it believes in.
 *
 * Deliberately all-or-nothing. Facet keeps no session table, so there is no list of devices to revoke
 * from and no per-device granularity to offer; the honest control is the one that ends everything,
 * which is also the one someone reaching for it actually wants.
 */
authRoutes.post('/logout-everywhere', async (c) => {
	const secret = requireSecret(c.env);
	const user = await sessionUser(c.env, getCookie(c, SESSION_COOKIE), secret, Date.now());
	if (!user) {
		throw new ApiError('unauthenticated', 401);
	}
	await revokeSessions(c.env, user.id);
	deleteCookie(c, SESSION_COOKIE, { path: '/' });
	return c.body(null, 204);
});
