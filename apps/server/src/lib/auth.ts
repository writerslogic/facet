// API-key auth for stats routes: parse the Authorization header, hash the key, and match it
// against api_keys (hashes only). Real verification + Hono middleware lands in T016.

import type { Env } from '../env.js';

/** Resolve a bearer API key to its owning site_id, or null if invalid. */
export async function authenticateKey(
	_env: Env,
	_authorization: string | null,
): Promise<string | null> {
	return null;
}
