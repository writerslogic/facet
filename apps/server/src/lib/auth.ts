// Authentication for the API. API-key auth resolves a bearer key to its owning site_id (matching
// only against stored hashes); admin auth compares a bearer token to ADMIN_TOKEN in constant time.
// Both middlewares raise the canonical 401 ApiError on failure.

import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv, Env } from '../env.js';
import { type Role, SESSION_COOKIE, roleAtLeast, sessionUser, siteRole } from './accounts.js';
import { type ApiKeyScope, hashKey, keyScopes } from './apikeys.js';
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

/** Coarsening window for the `last_used` bump. PERF: every authenticated request runs this path,
 * POST /api/event ingest included, so an unconditional write would make one D1 row per site a
 * serialized write hotspot on the hottest endpoint in the product. The column is only ever rendered
 * at day (dashboard) or clock-time (CLI) granularity, so a minute of coarsening is not observable. */
const LAST_USED_RESOLUTION_MS = 60_000;

/** True when the stored `last_used` is absent, older than the coarsening window, or ahead of `now`
 * (colo clock skew, which would otherwise freeze the column at a future timestamp forever). */
function shouldBumpLastUsed(lastUsed: number | null, now: number): boolean {
	if (lastUsed === null) {
		return true;
	}
	const age = now - lastUsed;
	return age >= LAST_USED_RESOLUTION_MS || age < 0;
}

/** Resolve a bearer API key to its owning site_id, or null if invalid. Bumps `last_used`. */
export async function authenticateKey(
	env: Env,
	authorization: string | null,
): Promise<string | null> {
	return (await authenticateKeyDetails(env, authorization))?.siteId ?? null;
}

export async function authenticateKeyDetails(
	env: Env,
	authorization: string | null,
): Promise<{ siteId: string; scopes: ApiKeyScope[] } | null> {
	const key = parseBearer(authorization);
	if (!key) {
		return null;
	}
	const keyHash = await hashKey(key);
	const row = await db(env)
		.select({
			id: schema.apiKeys.id,
			siteId: schema.apiKeys.siteId,
			lastUsed: schema.apiKeys.lastUsed,
		})
		.from(schema.apiKeys)
		.where(eq(schema.apiKeys.keyHash, keyHash))
		.get();
	if (!row) {
		return null;
	}
	const now = Date.now();
	if (shouldBumpLastUsed(row.lastUsed, now)) {
		try {
			await db(env)
				.update(schema.apiKeys)
				.set({ lastUsed: now })
				.where(eq(schema.apiKeys.keyHash, keyHash));
		} catch {
			// last_used is best-effort telemetry; never fail auth because the bump failed.
		}
	}
	return { siteId: row.siteId, scopes: await keyScopes(env, row.id) };
}

export function requireApiScope(scope: ApiKeyScope): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const key = await authenticateKeyDetails(c.env, c.req.header('Authorization') ?? null);
		if (!key) throw new ApiError('invalid_api_key', 401);
		if (!key.scopes.includes(scope)) throw new ApiError('insufficient_scope', 403);
		c.set('siteId', key.siteId);
		return next();
	};
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
	const key = await authenticateKeyDetails(c.env, c.req.header('Authorization') ?? null);
	if (key?.scopes.includes('read')) {
		c.set('siteId', key.siteId);
		return next();
	}
	const secret = c.env.SESSION_SECRET;
	const siteId = c.req.query('site_id');
	if (secret && siteId) {
		const user = await sessionUser(c.env, getCookie(c, SESSION_COOKIE), secret, Date.now());
		if (user && (await siteRole(c.env, user.id, siteId))) {
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
		const siteId = c.req.query('site_id');
		if (!siteId) {
			throw new ApiError('unauthorized', 401);
		}
		const user = await sessionUser(c.env, getCookie(c, SESSION_COOKIE), secret, Date.now());
		if (!user) {
			throw new ApiError('unauthorized', 401);
		}
		const role = await siteRole(c.env, user.id, siteId);
		if (!role || !roleAtLeast(role, need)) {
			throw new ApiError('forbidden', 403);
		}
		c.set('siteId', siteId);
		c.set('userId', user.id);
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
