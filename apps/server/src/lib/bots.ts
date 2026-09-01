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
 * IMPORTANT: a `user-agent` header is attacker-controlled and can be kilobytes. This caps the
 * subject, which caps but does not eliminate backtracking cost — 512 chars is already far past the
 * point where a catastrophic pattern stalls, so the shape screen below is what has to reject those.
 * Real user-agents run well under the cut, and a bot hiding past it would have to be unlike any real
 * browser, which the compiled-in `isbot` floor already catches.
 */
const MAX_MATCH_LENGTH = 512;

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

function isDigit(ch: string | undefined): boolean {
	return ch !== undefined && ch >= '0' && ch <= '9';
}

/** Width of an unbounded quantifier at `at`, or 0. A fixed `{n}` repeat cannot backtrack, so it is
 * not one; `{n,m}` is, because the screen errs toward rejecting. */
function quantifierWidth(source: string, at: number): number {
	const ch = source[at];
	if (ch === '+' || ch === '*') return 1;
	if (ch !== '{') return 0;
	let j = at + 1;
	const firstDigit = j;
	while (isDigit(source[j])) j++;
	if (j === firstDigit || source[j] !== ',') return 0;
	j++;
	while (isDigit(source[j])) j++;
	return source[j] === '}' ? j + 1 - at : 0;
}

// ReDoS screen: reject a group repeated without an upper bound whose body can itself match a
// variable number of characters — `(a+)+`, `(?:a*)*`, `(a{1,}){2,}`, `((a+))+`. Tracking nesting on
// a stack is what catches the last of those; a single regex over the source cannot, because the
// inner group's parentheses break any body class it can express. Overlapping alternations like
// `(a|a)+` are still missed, so this is a filter and not a proof, and MAX_MATCH_LENGTH above bounds
// what a surviving pattern is ever run against.
function isRedosShaped(source: string): boolean {
	const repeats: boolean[] = [false];
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === '[') {
			i++;
			while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
			i++;
			continue;
		}
		if (ch === '(') {
			repeats.push(false);
			i++;
			continue;
		}
		if (ch === ')') {
			const body = repeats.length > 1 ? repeats.pop() === true : false;
			const width = quantifierWidth(source, i + 1);
			if (width > 0 && body) return true;
			if (body || width > 0) repeats[repeats.length - 1] = true;
			i += 1 + width;
			continue;
		}
		const width = quantifierWidth(source, i);
		if (width > 0) {
			repeats[repeats.length - 1] = true;
			i += width;
			continue;
		}
		i++;
	}
	return false;
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
	// IMPORTANT: the cap is applied while merging, not after. Each row is bounded at MAX_PATTERNS but
	// the row count is not, so accumulating every row first and slicing sizes the merge off stored
	// data rather than off the bound.
	const sources: string[] = [];
	for (const row of rows) {
		const validated = validateRulesetPayload(safeParse(row.patterns));
		if (!validated) continue;
		for (const pattern of validated) {
			if (sources.length >= MAX_PATTERNS) break;
			sources.push(pattern);
		}
		if (sources.length >= MAX_PATTERNS) break;
	}
	primeBotPatterns(sources, key, now);
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
