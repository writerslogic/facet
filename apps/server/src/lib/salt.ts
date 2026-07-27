// Daily-rotating salt management: fetch (or lazily create) today's salt from the `salts` table
// so visitor hashes are un-linkable across UTC days. One salt per UTC day; created race-safe via
// INSERT OR IGNORE + re-select.

import type { Env } from '../env.js';
import { SALT_BYTES } from './constants.js';
import { randomHex } from './crypto.js';

/** UTC `YYYY-MM-DD` day key derived from a millisecond timestamp. */
export function dayKey(nowMs: number): string {
	const d = new Date(nowMs);
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

// A UTC day's salt is immutable once created, so cache it per Worker isolate: after the first beacon of
// a day, every subsequent one skips the `salts` read — the single hottest read on the ingest hot path
// (the anonymous Tier-0 branch hits it for every event). Bounded to a few keys; a day rollover leaves at
// most today plus a soon-evicted yesterday. Cleared by `resetDailySaltCache` so a test that seeds a
// specific salt after a prior read is not served the stale one.
const saltCache = new Map<string, string>();

function cacheSalt(dayKey: string, salt: string): void {
	saltCache.set(dayKey, salt);
	if (saltCache.size > 3) {
		for (const key of saltCache.keys()) {
			if (key !== dayKey) {
				saltCache.delete(key);
				break;
			}
		}
	}
}

/** Drop the in-memory salt cache (for tests that pre-seed a deterministic salt after a prior read). */
export function resetDailySaltCache(): void {
	saltCache.clear();
}

/** Return the salt for `dayKey` (UTC), creating it lazily and race-safely if absent. */
export async function getDailySalt(env: Env, dayKey: string, now: number): Promise<string> {
	const cached = saltCache.get(dayKey);
	if (cached) return cached;
	const existing = await env.DB.prepare('SELECT salt FROM salts WHERE day_key = ?')
		.bind(dayKey)
		.first<{ salt: string }>();
	if (existing?.salt) {
		cacheSalt(dayKey, existing.salt);
		return existing.salt;
	}
	const salt = randomHex(SALT_BYTES);
	await env.DB.prepare('INSERT OR IGNORE INTO salts (day_key, salt, created_at) VALUES (?, ?, ?)')
		.bind(dayKey, salt, now)
		.run();
	// Re-select: a concurrent insert may have won, so the stored value is authoritative.
	const row = await env.DB.prepare('SELECT salt FROM salts WHERE day_key = ?')
		.bind(dayKey)
		.first<{ salt: string }>();
	const resolved = row?.salt ?? salt;
	cacheSalt(dayKey, resolved);
	return resolved;
}
