// Natural-language analytics pipeline. The only place the Workers AI model id is pinned. The LLM is
// reached through an injectable LlmRunner so the whole pipeline is testable with a stub — no live AI
// binding required. The model only ever produces a constrained QueryIntent (validated), never SQL.

import {
	type NlQueryResult,
	type QueryIntent,
	QueryIntentSchema,
	type StatsFilter,
} from '@facet/shared';
import * as v from 'valibot';
import { runQueryIntent } from '../db/nlquery.js';
import type { Env } from '../env.js';
import { ApiError } from './http.js';
import { createLogger } from './log.js';

const MODEL = '@cf/meta/llama-3.1-8b-instruct';

// PERF: a well-formed QueryIntent is under 60 tokens, so this bounds per-request inference cost and
// the string handed to JSON.parse without ever truncating a valid answer.
const MAX_OUTPUT_TOKENS = 128;
const AI_TIMEOUT_MS = 10_000;

/** Async function that turns a prompt into raw model text. Injected so tests can stub the LLM. */
export type LlmRunner = (prompt: string) => Promise<string>;

/** Safe fallback when the model output can't be parsed or validated into a QueryIntent. */
const DEFAULT_INTENT: QueryIntent = { metric: 'pageviews' };

const SYSTEM_PROMPT = `You translate an analytics question into a JSON query intent.
Respond with ONLY a JSON object, no prose and no code fences.
Shape: { "metric": <metric>, "dimension"?: <dimension>, "limit"?: <1-50>, "series"?: <bool>, "interval"?: "hour"|"day" }
metric is one of: "pageviews", "visitors", "events", "sessions", "bounce_rate".
dimension (optional, include only for a top-N breakdown) is one of: "path", "referrer", "country", "device", "channel".
limit (optional, breakdowns only) is an integer between 1 and 50.
series (optional): set true for a trend/over-time question (ignored when a dimension is set); interval is "hour" or "day".`;

/** Production runner wrapping the Workers AI binding. Rejects when the binding yields no text. */
export function aiRunner(env: Env): LlmRunner {
	return async (prompt) => {
		const r = (await env.AI.run(
			MODEL,
			{ prompt, max_tokens: MAX_OUTPUT_TOKENS },
			{ signal: AbortSignal.timeout(AI_TIMEOUT_MS) },
		)) as { response?: unknown };
		if (typeof r.response !== 'string') {
			throw new Error('workers ai returned no response text');
		}
		return r.response;
	};
}

/** Strip Markdown code fences the model may wrap its JSON in. */
function stripFences(text: string): string {
	return text
		.replace(/^\s*```(?:json)?/i, '')
		.replace(/```\s*$/, '')
		.trim();
}

/**
 * Ask the model to translate a question, then parse + validate into a QueryIntent. Unusable model
 * output falls back; an unreachable model throws `ai_unavailable`.
 */
export async function translateQuery(runner: LlmRunner, question: string): Promise<QueryIntent> {
	const prompt = `${SYSTEM_PROMPT}\n\nQuestion: ${question}\nJSON:`;
	let raw: string;
	try {
		raw = await runner(prompt);
	} catch (err) {
		// IMPORTANT: an outage, timeout or exhausted quota is not an unanswerable question. Returning
		// DEFAULT_INTENT here would make the two indistinguishable to the caller and to the operator.
		// Only the error name is logged: an upstream inference message may echo the prompt.
		createLogger({ component: 'ai' }).error('nl_translate_upstream_failed', undefined, {
			cause: err instanceof Error ? err.name : 'unknown',
		});
		throw new ApiError('ai_unavailable', 503);
	}
	try {
		const result = v.safeParse(QueryIntentSchema, JSON.parse(stripFences(raw)));
		return result.success ? result.output : DEFAULT_INTENT;
	} catch {
		return DEFAULT_INTENT;
	}
}

/** Full pipeline: translate the question, then execute the intent over real aggregate helpers. */
export async function answerQuestion(
	env: Env,
	runner: LlmRunner,
	siteId: string,
	question: string,
	f: StatsFilter,
): Promise<NlQueryResult> {
	const intent = await translateQuery(runner, question);
	const result = await runQueryIntent(env, siteId, intent, f);
	// `translateQuery` returns this exact object (never a structurally-equal copy) whenever it fell
	// back, so identity is a precise fallback signal — the client used to guess this from an
	// English-only word list (AskPanel's now-removed looksLikeFallbackIntent).
	return { ...result, fallback: intent === DEFAULT_INTENT };
}
