// Authentication for the API. API-key auth resolves a bearer key to its owning site_id (matching
// only against stored hashes); admin auth compares a bearer token to ADMIN_TOKEN in constant time.
// Both middlewares raise the canonical 401 ApiError on failure.

import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv, Env } from '../env.js';
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

/** Middleware: require the admin bearer token, compared to ADMIN_TOKEN in constant time. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	const token = parseBearer(c.req.header('Authorization') ?? null);
	if (!token) {
		throw new ApiError('invalid_admin_token', 401);
	}
	const [provided, expected] = await Promise.all([
		sha256Hex(token),
		sha256Hex(c.env.ADMIN_TOKEN),
	]);
	if (!constantTimeEqualHex(provided, expected)) {
		throw new ApiError('invalid_admin_token', 401);
	}
	return next();
};
