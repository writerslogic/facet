// Operator-refreshable crawler list: fetch `FACET_BOT_RULESET_URL`, validate it as untrusted remote
// input, and store it in `bot_rulesets`, so the crawler list moves without a redeploy. The stored set
// is ADDITIVE only — see lib/bots.ts.

import { getBotRuleset, upsertBotRuleset } from '../db/bots.js';
import type { Env } from '../env.js';
import { ensureBotPatterns, resetBotPatterns, validateRulesetPayload } from './bots.js';

/** Stable primary key for the operator-configured upstream. */
export const REMOTE_SOURCE = 'remote';

const FETCH_TIMEOUT_MS = 10_000;
/** Hard bound on the response body, enforced while streaming — never by measuring a parsed string. */
const MAX_BODY_BYTES = 512 * 1024;

/** A refresh that failed against the upstream (unreachable, timed out, non-OK, oversized). */
export class BotRulesetFetchError extends Error {
	override name = 'BotRulesetFetchError';
}

/** A refresh whose payload failed boundary validation. */
export class BotRulesetInvalidError extends Error {
	override name = 'BotRulesetInvalidError';
}

/** `FACET_BOT_RULESET_URL` is present but unusable — the operator's own config, not the upstream's. */
export class BotRulesetConfigError extends Error {
	override name = 'BotRulesetConfigError';
}

/** Resolve and validate the configured upstream. Returns null when the feature is unconfigured. */
function resolveUrl(env: Env): URL | null {
	const raw = env.FACET_BOT_RULESET_URL?.trim();
	if (!raw) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new BotRulesetConfigError('FACET_BOT_RULESET_URL is not an absolute URL');
	}
	// IMPORTANT: these patterns are compiled into regexes that gate what the deployment records.
	// A plaintext fetch would let a network position rewrite that.
	if (url.protocol !== 'https:') {
		throw new BotRulesetConfigError('FACET_BOT_RULESET_URL must be https');
	}
	return url;
}

/** Read at most `MAX_BODY_BYTES` from a response, aborting past the cap rather than buffering it. */
async function readBounded(res: Response): Promise<string> {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		throw new BotRulesetFetchError('bot ruleset response exceeds the size limit');
	}
	const body = res.body;
	if (!body) return '';
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done || !result.value) break;
			total += result.value.byteLength;
			if (total > MAX_BODY_BYTES) {
				throw new BotRulesetFetchError('bot ruleset response exceeds the size limit');
			}
			chunks.push(result.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

/**
 * Refresh the stored bot ruleset from the operator-configured URL.
 *
 * No-op when `FACET_BOT_RULESET_URL` is unset — this runs on every deployment's cron, including the
 * ones that never configured it. A CONFIGURED refresh that fails throws a named error: the cron
 * registry catches per job, logs `job_failed:bot-ruleset-refresh`, records `last_error` (which
 * stores `err.name`, hence the distinct classes) and leaves `last_occurrence` untouched so the
 * next trigger retries. One attempt per run; no internal retry loop.
 */
export async function refreshBotRulesets(env: Env, now: number): Promise<void> {
	const url = resolveUrl(env);
	if (!url) return;

	const stored = await getBotRuleset(env, REMOTE_SOURCE);
	const headers: Record<string, string> = { accept: 'application/json' };
	if (stored?.etag) headers['if-none-match'] = stored.etag;

	let res: Response;
	try {
		res = await fetch(url.toString(), {
			headers,
			redirect: 'follow',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		throw new BotRulesetFetchError(
			`bot ruleset fetch failed: ${err instanceof Error ? err.name : 'unknown'}`,
		);
	}

	// 304: the upstream validator still matches, so nothing changed and nothing is written.
	if (res.status === 304) {
		await ensureBotPatterns(env, now);
		return;
	}
	if (!res.ok) {
		throw new BotRulesetFetchError(`bot ruleset fetch returned ${res.status}`);
	}
	// IMPORTANT: the https requirement is on the URL actually served, not just the configured one —
	// a redirect to http would otherwise put these patterns on the wire in the clear.
	if (res.url && new URL(res.url).protocol !== 'https:') {
		throw new BotRulesetFetchError('bot ruleset redirected to a non-https URL');
	}

	const text = await readBounded(res);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new BotRulesetInvalidError('bot ruleset payload is not valid JSON');
	}
	const patterns = validateRulesetPayload(parsed);
	if (!patterns) {
		throw new BotRulesetInvalidError('bot ruleset payload failed validation');
	}

	await upsertBotRuleset(env, REMOTE_SOURCE, patterns, res.headers.get('etag'), now);
	// The cache is TTL-guarded, so a just-written ruleset needs the cache invalidated to be seen.
	resetBotPatterns();
	await ensureBotPatterns(env, now);
}
