// API key issuance, hashing, listing, and revocation. Only key HASHES are ever stored; the
// plaintext key is returned exactly once at issuance and is never retrievable again.

import type { ApiKeyRecord } from '@facet/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { API_KEY_BYTES, API_KEY_PREFIX } from './constants.js';
import { randomHex, sha256Hex } from './crypto.js';

export const API_KEY_SCOPES = ['read', 'write', 'consent'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Narrow arbitrary stored scope strings to the current allowlist, dropping anything else (a
 * scope retired from `API_KEY_SCOPES` after being granted stays harmlessly in the table but is
 * never honored) and restoring `API_KEY_SCOPES`'s canonical order regardless of row order. */
function narrowScopes(values: string[]): ApiKeyScope[] {
	const set = new Set(values);
	return API_KEY_SCOPES.filter((scope) => set.has(scope));
}

/** Generate a fresh plaintext API key: prefix + random hex. */
export function generateKey(): string {
	return API_KEY_PREFIX + randomHex(API_KEY_BYTES);
}

/** SHA-256 lowercase-hex hash of a key. The only form ever stored or compared. */
export function hashKey(key: string): Promise<string> {
	return sha256Hex(key);
}

/** Issue a new key for a site. Returns the id and the plaintext key (shown once). One `.batch()`:
 * the key row and its scope rows must land together, or a crashed request between the two inserts
 * would mint a real, usable key with zero granted scopes. Scopes are narrowed first: a repeated
 * scope violates the `(api_key_id, scope)` primary key and would fail the whole issuance. */
export async function issueKey(
	env: Env,
	siteId: string,
	label: string | null,
	now: number,
	scopes: ApiKeyScope[] = [...API_KEY_SCOPES],
): Promise<{ id: string; key: string }> {
	const key = generateKey();
	const id = crypto.randomUUID();
	const granted = narrowScopes(scopes);
	const client = db(env);
	const stmts = [
		client.insert(schema.apiKeys).values({
			id,
			siteId,
			keyHash: await hashKey(key),
			label,
			createdAt: now,
			lastUsed: null,
		}),
		...(granted.length > 0
			? [
					client
						.insert(schema.apiKeyScopes)
						.values(granted.map((scope) => ({ apiKeyId: id, scope }))),
				]
			: []),
	];
	await client.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
	return { id, key };
}

/** List a site's keys as public records — never the hash or plaintext. Two queries (keys, then all
 * their scope rows) rather than a join: a key with zero scopes must still appear in the list, which
 * an inner join would drop and a left join would return as one null-scope row to unpack either way.
 * IMPORTANT: the scope query re-derives the site's key ids as a subquery rather than binding the ids
 * it just read — D1 caps bound parameters per statement, so binding them would make a site's key
 * count the parameter count and break this endpoint outright once a site accrues enough keys. */
export async function listKeys(env: Env, siteId: string): Promise<ApiKeyRecord[]> {
	const client = db(env);
	const keys = await client
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
	if (keys.length === 0) return [];
	const scopeRows = await client
		.select({ apiKeyId: schema.apiKeyScopes.apiKeyId, scope: schema.apiKeyScopes.scope })
		.from(schema.apiKeyScopes)
		.where(
			inArray(
				schema.apiKeyScopes.apiKeyId,
				client
					.select({ id: schema.apiKeys.id })
					.from(schema.apiKeys)
					.where(eq(schema.apiKeys.siteId, siteId)),
			),
		);
	const byKey = new Map<string, string[]>();
	for (const row of scopeRows) {
		const list = byKey.get(row.apiKeyId);
		if (list) list.push(row.scope);
		else byKey.set(row.apiKeyId, [row.scope]);
	}
	return keys.map((k) => ({ ...k, scopes: narrowScopes(byKey.get(k.id) ?? []) }));
}

/** The granted scopes for one key id, narrowed to the current allowlist. */
export async function keyScopes(env: Env, apiKeyId: string): Promise<ApiKeyScope[]> {
	const rows = await db(env)
		.select({ scope: schema.apiKeyScopes.scope })
		.from(schema.apiKeyScopes)
		.where(eq(schema.apiKeyScopes.apiKeyId, apiKeyId));
	return narrowScopes(rows.map((r) => r.scope));
}

/** Revoke a key by id, scoped to its site. Returns whether a row was deleted. One `.batch()`, scope
 * rows first: `api_key_scopes` has no foreign key to cascade on, so deleting the key alone strands
 * its scope rows in the table forever. The scope delete re-derives ownership through a subquery
 * rather than trusting `id`, so a caller passing another site's key id strips nothing. */
export async function revokeKey(env: Env, id: string, siteId: string): Promise<boolean> {
	const client = db(env);
	const owned = and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.siteId, siteId));
	const [, deleted] = await client.batch([
		client
			.delete(schema.apiKeyScopes)
			.where(
				inArray(
					schema.apiKeyScopes.apiKeyId,
					client.select({ id: schema.apiKeys.id }).from(schema.apiKeys).where(owned),
				),
			),
		client.delete(schema.apiKeys).where(owned).returning({ id: schema.apiKeys.id }),
	]);
	return deleted.length > 0;
}
