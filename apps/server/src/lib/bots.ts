// Bot filtering. The compiled-in `isbot` list is the FLOOR: operator-refreshed patterns
// (`bot_rulesets`, see lib/bots-refresh.ts) are strictly additive, so a bad, empty or hostile
// refresh can never make the deployment start recording crawlers it already dropped.
// Empty/whitespace user-agents count as bots.

import { isbot } from 'isbot';
import { listBotRulesets } from '../db/bots.js';
import type { Env } from '../env.js';

/** Wholesale bounds on a fetched ruleset. Anything past these rejects the payload entirely. */
export const MAX_PATTERNS = 2000;
export const MAX_PATTERN_LENGTH = 200;

/** How long a compiled cache is trusted before an isolate re-checks D1 for a newer ruleset. */
const CACHE_TTL_MS = 60_000;

/**
 * Longest prefix of a user-agent the refreshed patterns ever see.
 *
 * IMPORTANT: this is the ReDoS bound. A `user-agent` header is attacker-controlled and can be
 * kilobytes; catastrophic backtracking is exponential in subject length, so without this an operator
 * ruleset that slips past the shape screen turns one request into unbounded Worker CPU. Real
 * user-agents run well under 512 chars, so a bot hiding past the cut would have to be unlike any
 * real browser — which the compiled-in `isbot` floor already catches.
 */
const MAX_MATCH_LENGTH = 512;

// ReDoS screen: a quantified group whose body itself ends in an unbounded quantifier — `(a+)+`,
// `(?:a*)*`, `(a{1,}){2,}`. It is a cheap filter, not the bound: it misses `((a+))+` (the body class
// excludes `(`) and overlapping alternations like `(a|a)+` entirely. Pattern-shape screening is
// whack-a-mole, so the actual guarantee is MAX_MATCH_LENGTH below — backtracking blows up in the
// length of the SUBJECT, and bounding that caps the whole loop at O(patterns) regardless of shape.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})\)(?:[+*]|\{\d+,\d*\})/;

/** Reference human user-agent. Any refreshed pattern matching it is over-broad and is dropped. */
const CANARY_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface PatternCache {
	/** Identity of the stored rulesets this cache was compiled from (source + updatedAt). */
	key: string;
	patterns: RegExp[];
	loadedAt: number;
}

let cache: PatternCache = { key: '', patterns: [], loadedAt: 0 };

/**
 * Validate an untrusted ruleset payload at the boundary.
 *
 * Returns the pattern sources, or null if the payload is rejected WHOLESALE: it must be a JSON
 * array of strings, no more than `MAX_PATTERNS` entries, none longer than `MAX_PATTERN_LENGTH`.
 * A payload that breaks a bound is treated as untrustworthy rather than truncated.
 */
export function validateRulesetPayload(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	if (raw.length > MAX_PATTERNS) return null;
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'string') return null;
		if (entry.length === 0 || entry.length > MAX_PATTERN_LENGTH) return null;
		out.push(entry);
	}
	return out;
}

/** True for a pattern whose shape makes catastrophic backtracking plausible. */
function isRedosShaped(source: string): boolean {
	return NESTED_QUANTIFIER.test(source);
}

/**
 * Compile validated sources, dropping individually bad ones rather than failing the set.
 *
 * A ReDoS-shaped pattern or one `new RegExp` throws on is skipped; the rest still compile.
 * Case-insensitive and nothing else — a `g` flag would make `test` stateful via `lastIndex` and
 * `isBot` would then answer differently for the same user-agent on successive calls.
 */
export function compilePatterns(sources: readonly string[]): RegExp[] {
	const out: RegExp[] = [];
	for (const source of sources.slice(0, MAX_PATTERNS)) {
		if (source.length > MAX_PATTERN_LENGTH || isRedosShaped(source)) continue;
		let compiled: RegExp;
		try {
			compiled = new RegExp(source, 'i');
		} catch {
			continue;
		}
		// IMPORTANT: a pattern that flags a plain desktop browser is wrong by definition, and `.*`
		// would otherwise pass every screen above and silently drop all traffic.
		if (compiled.test(CANARY_UA)) continue;
		out.push(compiled);
	}
	return out;
}

/** Install a compiled pattern set into the isolate cache under a cache identity. */
export function primeBotPatterns(sources: readonly string[], key: string, now: number): void {
	cache = { key, patterns: compilePatterns(sources), loadedAt: now };
}

/** Drop the isolate cache, returning `isBot` to the compiled-in floor. */
export function resetBotPatterns(): void {
	cache = { key: '', patterns: [], loadedAt: 0 };
}

/** How many refreshed patterns are live in this isolate's cache. */
export function botPatternCount(): number {
	return cache.patterns.length;
}

/**
 * Ensure the isolate's compiled pattern cache is current.
 *
 * PERF: compiles at most once per distinct `(source, updated_at)` set and re-reads D1 at most once
 * per `CACHE_TTL_MS` per isolate — never per request. A D1 failure leaves the previous cache in
 * place; degrading to the `isbot` floor is always safe because the refreshed set is additive.
 */
export async function ensureBotPatterns(env: Env, now: number = Date.now()): Promise<void> {
	if (now - cache.loadedAt < CACHE_TTL_MS) return;
	let rows: Awaited<ReturnType<typeof listBotRulesets>>;
	try {
		rows = await listBotRulesets(env);
	} catch {
		cache = { ...cache, loadedAt: now };
		return;
	}
	const key = rows
		.map((r) => `${r.source}@${r.updatedAt}`)
		.sort()
		.join('|');
	if (key === cache.key) {
		cache = { ...cache, loadedAt: now };
		return;
	}
	const sources: string[] = [];
	for (const row of rows) {
		const parsed = safeParse(row.patterns);
		const validated = validateRulesetPayload(parsed);
		if (validated) sources.push(...validated);
	}
	primeBotPatterns(sources.slice(0, MAX_PATTERNS), key, now);
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Returns true if the user-agent looks like a bot/crawler and should be dropped. */
export function isBot(userAgent: string): boolean {
	if (!userAgent.trim()) {
		return true;
	}
	if (isbot(userAgent)) {
		return true;
	}
	const subject =
		userAgent.length > MAX_MATCH_LENGTH ? userAgent.slice(0, MAX_MATCH_LENGTH) : userAgent;
	for (const pattern of cache.patterns) {
		if (pattern.test(subject)) return true;
	}
	return false;
}
