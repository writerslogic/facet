// Passwordless account auth (Phase 4). POST /request issues a single-use magic-link token; POST /verify
// exchanges it for an HMAC-signed session cookie; GET /me returns the signed-in user + team roles; POST
// /logout clears the cookie. All account auth is gated on SESSION_SECRET — absent, these return 503 and
// the per-site API-key path (beacon, programmatic stats) is entirely unaffected.

import { vValidator } from '@hono/valibot-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as v from 'valibot';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import {
	SESSION_COOKIE,
	consumeMagicToken,
	createMagicToken,
	signSession,
	upsertUserByEmail,
	userMemberships,
	verifySession,
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
	const session = await signSession(user.id, secret, now);
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
	const token = getCookie(c, SESSION_COOKIE);
	const payload = token ? await verifySession(token, secret, Date.now()) : null;
	if (!payload) {
		throw new ApiError('unauthenticated', 401);
	}
	const user = await db(c.env)
		.select({
			id: schema.users.id,
			email: schema.users.email,
			name: schema.users.name,
		})
		.from(schema.users)
		.where(eq(schema.users.id, payload.sub))
		.get();
	if (!user) {
		throw new ApiError('unauthenticated', 401);
	}
	return c.json({ user, memberships: await userMemberships(c.env, user.id) });
});

authRoutes.post('/logout', (c) => {
	deleteCookie(c, SESSION_COOKIE, { path: '/' });
	return c.body(null, 204);
});
