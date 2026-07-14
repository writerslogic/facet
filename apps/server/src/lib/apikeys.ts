// API key issuance, hashing, listing, and revocation. Only key HASHES are ever stored; the
// plaintext key is returned exactly once at issuance and is never retrievable again.

import type { ApiKeyRecord } from '@countless/shared';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { API_KEY_BYTES, API_KEY_PREFIX } from './constants.js';
import { randomHex, sha256Hex } from './crypto.js';

/** Generate a fresh plaintext API key: prefix + random hex. */
export function generateKey(): string {
	return API_KEY_PREFIX + randomHex(API_KEY_BYTES);
}

/** SHA-256 lowercase-hex hash of a key. The only form ever stored or compared. */
export function hashKey(key: string): Promise<string> {
	return sha256Hex(key);
}

/** Issue a new key for a site. Returns the id and the plaintext key (shown once). */
export async function issueKey(
	env: Env,
	siteId: string,
	label: string | null,
	now: number,
): Promise<{ id: string; key: string }> {
	const key = generateKey();
	const id = crypto.randomUUID();
	await db(env)
		.insert(schema.apiKeys)
		.values({
			id,
			siteId,
			keyHash: await hashKey(key),
			label,
			createdAt: now,
			lastUsed: null,
		});
	return { id, key };
}

/** List a site's keys as public records — never the hash or plaintext. */
export async function listKeys(env: Env, siteId: string): Promise<ApiKeyRecord[]> {
	return db(env)
		.select({
			id: schema.apiKeys.id,
			site_id: schema.apiKeys.siteId,
			label: schema.apiKeys.label,
			created_at: schema.apiKeys.createdAt,
			last_used: schema.apiKeys.lastUsed,
		})
		.from(schema.apiKeys)
		.where(eq(schema.apiKeys.siteId, siteId))
		.orderBy(desc(schema.apiKeys.createdAt));
}

/** Revoke a key by id, scoped to its site. Returns whether a row was deleted. */
export async function revokeKey(env: Env, id: string, siteId: string): Promise<boolean> {
	const deleted = await db(env)
		.delete(schema.apiKeys)
		.where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.siteId, siteId)))
		.returning({ id: schema.apiKeys.id });
	return deleted.length > 0;
}
