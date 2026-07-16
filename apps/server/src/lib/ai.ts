// Natural-language analytics pipeline. The only place the Workers AI model id is pinned. The LLM is
// reached through an injectable LlmRunner so the whole pipeline is testable with a stub — no live AI
// binding required. The model only ever produces a constrained QueryIntent (validated), never SQL.

import {
	type NlQueryResult,
	type QueryIntent,
	QueryIntentSchema,
	type StatsFilter,
} from '@countless/shared';
import * as v from 'valibot';
import { runQueryIntent } from '../db/nlquery.js';
import type { Env } from '../env.js';

const MODEL = '@cf/meta/llama-3.1-8b-instruct';

/** Async function that turns a prompt into raw model text. Injected so tests can stub the LLM. */
export type LlmRunner = (prompt: string) => Promise<string>;

/** Safe fallback when the model output can't be parsed or validated into a QueryIntent. */
const DEFAULT_INTENT: QueryIntent = { metric: 'pageviews' };

const SYSTEM_PROMPT = `You translate an analytics question into a JSON query intent.
Respond with ONLY a JSON object, no prose and no code fences.
Shape: { "metric": <metric>, "dimension"?: <dimension>, "limit"?: <1-50> }
metric is one of: "pageviews", "visitors", "events", "sessions", "bounce_rate".
dimension (optional, include only for a top-N breakdown) is one of: "path", "referrer", "country", "device", "channel".
limit (optional, breakdowns only) is an integer between 1 and 50.`;

/** Production runner wrapping the Workers AI binding. */
export function aiRunner(env: Env): LlmRunner {
	return (prompt) => env.AI.run(MODEL, { prompt }).then((r) => r.response ?? '');
}

/** Strip Markdown code fences the model may wrap its JSON in. */
function stripFences(text: string): string {
	return text
		.replace(/^\s*```(?:json)?/i, '')
		.replace(/```\s*$/, '')
		.trim();
}

/** Ask the model to translate a question, then parse + validate into a QueryIntent (or fall back). */
export async function translateQuery(runner: LlmRunner, question: string): Promise<QueryIntent> {
	const prompt = `${SYSTEM_PROMPT}\n\nQuestion: ${question}\nJSON:`;
	try {
		const raw = await runner(prompt);
		const parsed = JSON.parse(stripFences(raw));
		const result = v.safeParse(QueryIntentSchema, parsed);
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
	return runQueryIntent(env, siteId, intent, f);
}
