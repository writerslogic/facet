// Authentication for the API. API-key auth resolves a bearer key to its owning site_id (matching
// only against stored hashes); admin auth compares a bearer token to ADMIN_TOKEN in constant time.
// Both middlewares raise the canonical 401 ApiError on failure.

import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv, Env } from '../env.js';
import { type Role, SESSION_COOKIE, roleAtLeast, siteRole, verifySession } from './accounts.js';
import { hashKey } from './apikeys.js';
import { constantTimeEqualHex, sha256Hex } from './crypto.js';
import { ApiError } from './http.js';

/** Extract the token from a `Bearer <token>` header, or null if missing/malformed. */
function parseBearer(authorization: string | null): string | null {
	if (!authorization) {
		return null;
	}
	const match = authorization.match(/^Bearer\s+(.+)$/);
	return match?.[1] ?? null;
}

/** Resolve a bearer API key to its owning site_id, or null if invalid. Bumps `last_used`. */
export async function authenticateKey(
	env: Env,
	authorization: string | null,
): Promise<string | null> {
	const key = parseBearer(authorization);
	if (!key) {
		return null;
	}
	const keyHash = await hashKey(key);
	const row = await db(env)
		.select({ siteId: schema.apiKeys.siteId })
		.from(schema.apiKeys)
		.where(eq(schema.apiKeys.keyHash, keyHash))
		.get();
	if (!row) {
		return null;
	}
	try {
		await db(env)
			.update(schema.apiKeys)
			.set({ lastUsed: Date.now() })
			.where(eq(schema.apiKeys.keyHash, keyHash));
	} catch {
		// last_used is best-effort telemetry; never fail auth because the bump failed.
	}
	return row.siteId;
}

/** Middleware: require a valid API key and expose its site_id as `c.get('siteId')`. */
export const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
	const siteId = await authenticateKey(c.env, c.req.header('Authorization') ?? null);
	if (!siteId) {
		throw new ApiError('invalid_api_key', 401);
	}
	c.set('siteId', siteId);
	return next();
};

/**
 * Read access to a site's analytics via EITHER a per-site API key (unchanged, programmatic) OR a
 * dashboard session cookie whose user holds any role on the team that owns the requested `site_id`.
 * Sets `c.get('siteId')`. The RBAC integration: session users only ever see sites their team owns,
 * while the API-key path stays byte-for-byte as before.
 */
export const requireSiteAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
	const keySite = await authenticateKey(c.env, c.req.header('Authorization') ?? null);
	if (keySite) {
		c.set('siteId', keySite);
		return next();
	}
	const secret = c.env.SESSION_SECRET;
	const token = getCookie(c, SESSION_COOKIE);
	const siteId = c.req.query('site_id');
	if (secret && token && siteId) {
		const payload = await verifySession(token, secret, Date.now());
		if (payload && (await siteRole(c.env, payload.sub, siteId))) {
			c.set('siteId', siteId);
			return next();
		}
	}
	throw new ApiError('unauthorized', 401);
};

/**
 * Require an authenticated OPERATOR session holding at least `need` on the team that owns `site_id`.
 *
 * This deliberately does NOT accept an API key, and that is the whole point of it existing next to
 * `requireSiteAccess`. A `clk_` key reads aggregate analytics and is handed out accordingly — /llms.txt
 * advertises where to send one, and a public demo dashboard can ship with one embedded
 * (VITE_FACET_DEMO_API_KEY). Aggregates survive that; contact PII would not. So every route that can
 * return a name, an email, or a phone number is gated on a session cookie instead: an identity that
 * belongs to a person, carries a role, and can be revoked for that person alone.
 *
 * Sets `siteId`, `userId` and `role`. Failure modes are deliberately coarse — "no session", "session
 * but no sufficient role" — and nothing distinguishes a site that does not exist from one the caller
 * has no role on, so probing site ids reveals nothing.
 */
export function requireTeamRole(need: Role): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		// No SESSION_SECRET means the whole account system is off (as in /api/auth), so there is no
		// way to authenticate an operator and the resource is unavailable rather than unauthorized.
		const secret = c.env.SESSION_SECRET;
		if (!secret) {
			throw new ApiError('auth_unavailable', 503, 'account auth is not configured');
		}
		const token = getCookie(c, SESSION_COOKIE);
		const siteId = c.req.query('site_id');
		if (!token || !siteId) {
			throw new ApiError('unauthorized', 401);
		}
		const payload = await verifySession(token, secret, Date.now());
		if (!payload) {
			throw new ApiError('unauthorized', 401);
		}
		const role = await siteRole(c.env, payload.sub, siteId);
		if (!role || !roleAtLeast(role, need)) {
			throw new ApiError('forbidden', 403);
		}
		c.set('siteId', siteId);
		c.set('userId', payload.sub);
		c.set('role', role);
		return next();
	};
}

/** Middleware: require the admin bearer token, compared to ADMIN_TOKEN in constant time. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	// Fail closed when the secret is unset: sha256Hex(undefined) would coerce to sha256Hex("undefined"),
	// letting `Bearer undefined` authenticate on a misconfigured deploy.
	const expectedToken = c.env.ADMIN_TOKEN;
	if (!expectedToken) {
		throw new ApiError('invalid_admin_token', 401);
	}
	const token = parseBearer(c.req.header('Authorization') ?? null);
	if (!token) {
		throw new ApiError('invalid_admin_token', 401);
	}
	const [provided, expected] = await Promise.all([sha256Hex(token), sha256Hex(expectedToken)]);
	if (!constantTimeEqualHex(provided, expected)) {
		throw new ApiError('invalid_admin_token', 401);
	}
	return next();
};
