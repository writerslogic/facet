// Operator-refreshable bot ruleset storage. One row per upstream source.

import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import { db } from './queries.js';
import * as schema from './schema.js';

export interface BotRulesetRow {
	source: string;
	patterns: string;
	etag: string | null;
	patternCount: number;
	updatedAt: number;
}

/** Read one source's stored ruleset, or null when it has never been refreshed. */
export async function getBotRuleset(env: Env, source: string): Promise<BotRulesetRow | null> {
	const row = await db(env)
		.select({
			source: schema.botRulesets.source,
			patterns: schema.botRulesets.patterns,
			etag: schema.botRulesets.etag,
			patternCount: schema.botRulesets.patternCount,
			updatedAt: schema.botRulesets.updatedAt,
		})
		.from(schema.botRulesets)
		.where(eq(schema.botRulesets.source, source))
		.get();
	return row ?? null;
}

/** Every stored ruleset. The compiled pattern cache is built from all sources at once. */
export async function listBotRulesets(env: Env): Promise<BotRulesetRow[]> {
	// IMPORTANT: deterministic order — ensureBotPatterns caps the merged set, so row order decides
	// which patterns survive.
	return db(env)
		.select({
			source: schema.botRulesets.source,
			patterns: schema.botRulesets.patterns,
			etag: schema.botRulesets.etag,
			patternCount: schema.botRulesets.patternCount,
			updatedAt: schema.botRulesets.updatedAt,
		})
		.from(schema.botRulesets)
		.orderBy(schema.botRulesets.source);
}

/** Replace a source's ruleset. `patterns` is a JSON array of regex source strings. */
export async function upsertBotRuleset(
	env: Env,
	source: string,
	patterns: string[],
	etag: string | null,
	now: number,
): Promise<void> {
	const encoded = JSON.stringify(patterns);
	await db(env)
		.insert(schema.botRulesets)
		.values({
			source,
			patterns: encoded,
			etag,
			patternCount: patterns.length,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: schema.botRulesets.source,
			set: { patterns: encoded, etag, patternCount: patterns.length, updatedAt: now },
		});
}
