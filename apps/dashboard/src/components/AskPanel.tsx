// Ask view: a plain-English analytics question box. On submit it POSTs to /api/stats/query and renders
// the answer as a scalar Card, a breakdown TopList, or a series TrafficChart.
//
// The trust model is the feature, so the UI states it plainly instead of hinting at it. No model text
// ever reaches this screen: the model's ONLY output is a QueryIntent (a metric, plus an optional
// dimension / series / interval / limit), each field validated against a fixed picklist server-side.
// The server then executes that intent over the same aggregate helpers the rest of the dashboard uses
// and templates the answer sentence from the executed result. That makes "what the model chose" and
// "what your data says" two separable things, and the readout labels them separately.
//
// Two consequences the panel has to handle honestly:
//   - When the model's output can't be parsed or validated, the server silently falls back to the
//     default intent (total pageviews). Rendered bare, an unanswerable question comes back looking
//     like a confident answer, so we flag the likely-fallback case.
//   - The answer is only as meaningful as its window, so the window is always shown — and can be
//     overridden per-question without moving the dashboard's global range.
//
// Recent questions are kept locally (text + timestamp only) — click to replay, remove, or clear.

import type { CountRow, NlQueryResult, QueryIntent, SeriesPoint } from '@facet/shared';
import { Check, Copy, History, Info, Loader2, X } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { QUESTION_MAX_LEN, useNlQuery } from '../hooks/query.js';
import {
	type AskEntry,
	clearAskHistory,
	formatAskAge,
	pushAskHistory,
	readAskHistory,
	removeAskHistory,
} from '../lib/askHistory.js';
import { formatIso, formatWindowLabel, useClockMode } from '../lib/datetime.js';
import { formatNumber, formatPercent } from '../lib/format.js';
import { ASK_INPUT_ID } from '../lib/shortcuts.js';
import { RANGE_PRESETS, type Range, type RangePreset, rangeForPreset } from '../state.js';
import { Card } from './Card.js';
import { SegmentNotice } from './CubeFilterBar.js';
import { TopList } from './TopList.js';
import { TrafficChart } from './TrafficChart.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Display names for the two closed vocabularies the model is allowed to choose from. */
const METRIC_LABELS: Record<QueryIntent['metric'], string> = {
	pageviews: 'pageviews',
	visitors: 'visitors',
	events: 'events',
	sessions: 'sessions',
	bounce_rate: 'bounce rate',
};

const DIMENSION_LABELS: Record<NonNullable<QueryIntent['dimension']>, string> = {
	path: 'pages',
	referrer: 'referrers',
	country: 'countries',
	device: 'devices',
	channel: 'channels',
};

// Derived from the label maps so the vocabulary shown to the reader can never drift from the picklists
// the server validates against (QueryIntentSchema).
const METRIC_VOCABULARY = Object.keys(METRIC_LABELS).join(', ');
const DIMENSION_VOCABULARY = Object.keys(DIMENSION_LABELS).join(', ');

/** Human labels for the per-answer window overrides. */
const PRESET_LABELS: Record<RangePreset, string> = {
	'24h': 'Last 24h',
	'7d': 'Last 7 days',
	'30d': 'Last 30 days',
	'90d': 'Last 90 days',
};

/** The answer window: the dashboard's own range, or a preset scoped to this panel only. */
type Scope = 'dashboard' | RangePreset;

/** Starter questions, one per supported shape (scalar, trend, breakdown), so the first click works. */
const EXAMPLES = [
	'How many visitors this period?',
	'Show the pageview trend by day',
	'Top pages',
	'Top referrers',
	'What is the bounce rate?',
] as const;

/**
 * Actionable text for a failed ask. Every code here is one the server can actually return for
 * `POST /api/stats/query` (or the client's own `request_failed` fallback) — a generic "something went
 * wrong" leaves the reader with nothing to do, and most of these have an exact remedy.
 */
export function errorHint(message: string): string {
	switch (message) {
		case 'ai_unavailable':
			return 'Ask needs the Workers AI binding. Enable `AI` in wrangler.jsonc and redeploy — every other tab keeps working without it.';
		case 'bad_request':
			return `That question could not be sent. Keep it under ${QUESTION_MAX_LEN} characters and try again.`;
		case 'bad_range':
		case 'range_too_large':
			return 'The selected window is not valid. Pick a range of 90 days or less and ask again.';
		case 'site_mismatch':
			return 'This API key does not grant access to the selected site. Switch profiles in Settings.';
		case 'invalid_api_key':
		case 'unauthorized':
			return 'The API key was rejected. Check the key on the active profile in Settings.';
		case 'request_failed':
			return 'The request did not reach the server. Check your connection and ask again.';
		default:
			return `Something went wrong: ${message}`;
	}
}

/**
 * Words that would make "pageviews" a correct resolution rather than a fallback. Used only to suppress
 * the fallback notice — a miss here costs a redundant hint, never a wrong number.
 */
const PAGEVIEW_TERMS = [
	'pageview',
	'page view',
	'view',
	'hit',
	'traffic',
	'busy',
	'impression',
	'load',
];

/**
 * Whether a result looks like the server's silent fallback rather than a real resolution.
 *
 * `translateQuery` returns `{ metric: 'pageviews' }` whenever the model's output fails to parse or
 * validate, and that is indistinguishable on the wire from a genuine "how many pageviews?" — so the
 * signal is: the barest possible intent came back for a question that never mentioned pageviews. The
 * notice is phrased as a check, not a verdict, because this is a heuristic.
 */
export function looksLikeFallbackIntent(question: string, intent: QueryIntent): boolean {
	if (question.trim().length === 0) return false;
	if (intent.metric !== 'pageviews') return false;
	if (intent.dimension || intent.series || intent.limit != null) return false;
	const q = question.toLowerCase();
	return !PAGEVIEW_TERMS.some((term) => q.includes(term));
}

/**
 * The window an answer covers, in the reader's active clock and always naming it. This used to be
 * hardcoded to `en-US` and to UTC while the tab beside it rendered dates in the browser's timezone;
 * both now come from `lib/datetime.ts`. Times are shown only for short windows, where the hour is
 * what distinguishes one answer from another.
 */
export function formatWindow(range: Range): string {
	return formatWindowLabel(range.start, range.end, range.end - range.start <= 2 * DAY_MS);
}

/** Scalar metrics are not all counts: bounce rate arrives as a 0..1 fraction and must read as one. */
export function formatMetricValue(metric: QueryIntent['metric'], value: number): string {
	return metric === 'bounce_rate' ? formatPercent(value) : formatNumber(value);
}

/** One human sentence for the resolved intent, used in the readout and in the copied text. */
export function describeIntent(intent: QueryIntent): string {
	const metric = METRIC_LABELS[intent.metric];
	if (intent.dimension) {
		return `Top ${intent.limit ?? 10} ${DIMENSION_LABELS[intent.dimension]} by ${metric}`;
	}
	if (intent.series) {
		return `${metric} over time, bucketed by ${intent.interval ?? 'day'}`;
	}
	return `Total ${metric}`;
}

function tsv(rows: string[][]): string {
	return rows.map((r) => r.join('\t')).join('\n');
}

/**
 * Plain-text rendering of an answer for the clipboard: the question, the window it was answered over,
 * the resolved intent, and the underlying rows as TSV so the numbers paste into a spreadsheet. The
 * provenance travels WITH the numbers — a pasted figure with no window or intent attached is exactly
 * how an analytics number ends up misquoted.
 */
export function buildAnswerText(question: string, range: Range, data: NlQueryResult): string {
	const head = [
		`Question: ${question}`,
		`Window: ${formatWindow(range)}`,
		`Resolved query: ${describeIntent(data.intent)}`,
		`Answer: ${data.answer}`,
		'',
	];
	if (data.result.kind === 'scalar') {
		const metric = METRIC_LABELS[data.intent.metric];
		return [
			...head,
			tsv([[metric, formatMetricValue(data.intent.metric, data.result.value)]]),
		].join('\n');
	}
	if (data.result.kind === 'breakdown') {
		const dimension = data.intent.dimension ?? 'key';
		const body: string[][] = [
			[dimension, 'count'],
			...data.result.rows.map((r: CountRow) => [r.key, String(r.count)]),
		];
		return [...head, tsv(body)].join('\n');
	}
	const body: string[][] = [
		['time', 'pageviews', 'visitors'],
		...data.result.points.map((p: SeriesPoint) => [
			// The pasted rows stay ISO/UTC whatever the on-screen clock: this is machine data headed
			// for a spreadsheet, and an unqualified local timestamp there is unreconcilable.
			formatIso(p.t),
			String(p.pageviews),
			String(p.visitors),
		]),
	];
	return [...head, tsv(body)].join('\n');
}

/** True when the executed query came back with nothing to show (as opposed to a real zero). */
function isEmptyResult(result: NlQueryResult['result']): boolean {
	if (result.kind === 'breakdown') return result.rows.length === 0;
	if (result.kind === 'series') {
		return result.points.every((p) => p.pageviews === 0 && p.visitors === 0);
	}
	return false;
}

/** Copy-to-clipboard control for an answer (text built by `buildAnswerText`). */
function CopyAnswer({ text }: { text: string }): ReactElement {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={() => {
				navigator.clipboard?.writeText(text).then(
					() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					},
					() => {
						// clipboard blocked (insecure context / permissions) — the answer stays selectable
					},
				);
			}}
			className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[color:rgb(var(--border))] px-2 py-1 font-medium text-[11px] text-[color:var(--muted)] transition-colors hover:text-[color:var(--ink)]"
		>
			{copied ? (
				<Check className="h-3 w-3" aria-hidden="true" />
			) : (
				<Copy className="h-3 w-3" aria-hidden="true" />
			)}
			{copied ? 'Copied' : 'Copy answer'}
		</button>
	);
}

/**
 * What the question was resolved to, split by provenance. The chips are the model's entire
 * contribution; everything else on screen is computed from the site's own aggregates. Showing the
 * closed vocabulary next to the choice is what lets a reader verify they were asked what they meant.
 */
function IntentReadout({ intent, range }: { intent: QueryIntent; range: Range }): ReactElement {
	const chips = [
		`metric: ${intent.metric}`,
		intent.dimension ? `by: ${intent.dimension}` : null,
		intent.series ? `series: ${intent.interval ?? 'day'}` : null,
		intent.limit ? `limit: ${intent.limit}` : null,
	].filter((c): c is string => c !== null);
	return (
		<div className="surface-2 rounded-xl px-4 py-3">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
				<span
					data-chrome
					className="font-medium text-[11px] text-[color:var(--faint)] uppercase tracking-wide"
				>
					Model chose
				</span>
				{chips.map((chip) => (
					<span
						key={chip}
						className="badge-neutral rounded-full px-2 py-0.5 font-mono text-[11px]"
					>
						{chip}
					</span>
				))}
			</div>
			<p data-chrome className="mt-2 text-[color:var(--muted)] text-xs">
				That is the model's only output — a query shape picked from a fixed list, validated
				before it runs. The numbers above are computed from your own aggregates over{' '}
				<span className="text-[color:var(--ink)]">{formatWindow(range)}</span>. No SQL is
				ever generated from the question.
			</p>
		</div>
	);
}

/** The closed vocabulary, shown wherever a reader needs to know what they can actually ask for. */
function Vocabulary(): ReactElement {
	return (
		<p data-chrome className="text-[color:var(--muted)] text-xs">
			<span>Answerable metrics: </span>
			<span className="font-mono">{METRIC_VOCABULARY}</span>
			<span>. Breakdowns: </span>
			<span className="font-mono">{DIMENSION_VOCABULARY}</span>
			<span>.</span>
		</p>
	);
}

export function AskPanel({
	apiKey,
	siteId,
	range,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
}): ReactElement {
	const [question, setQuestion] = useState('');
	const [scope, setScope] = useState<Scope>('dashboard');
	const [history, setHistory] = useState<AskEntry[]>(() => readAskHistory());
	// The question + window that produced the answer currently on screen. Kept separately from the
	// input and the scope chips so editing either one doesn't silently relabel an existing answer.
	const [answered, setAnswered] = useState<{ question: string; range: Range } | null>(null);
	const mutation = useNlQuery(apiKey, siteId);
	const data = mutation.data;
	// Every window label below names its clock; re-render when the reader switches it.
	useClockMode();

	function run(text: string): void {
		const trimmed = text.trim().slice(0, QUESTION_MAX_LEN);
		if (!trimmed) return;
		setQuestion(trimmed);
		// Resolve the preset at ask time: a relative window ("last 24h") must be pinned to the moment
		// the question was asked, or the label would drift away from the numbers it describes.
		const asked = {
			question: trimmed,
			range: scope === 'dashboard' ? range : rangeForPreset(scope),
		};
		mutation.mutate(asked, { onSuccess: () => setAnswered(asked) });
		setHistory(pushAskHistory(trimmed));
	}

	// Falls back to the live props when no ask has completed in this session (e.g. a restored result).
	const context = answered ?? { question, range };
	const empty = data ? isEmptyResult(data.result) : false;
	const fallback = data ? looksLikeFallbackIntent(context.question, data.intent) : false;

	return (
		<div className="space-y-6">
			{/* The question executor receives { siteId, start, end } and nothing else, so an answer
			    here is never scoped to the active segment. Say it before the question is asked. */}
			<SegmentNotice tab="ask" />
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					run(question);
				}}
			>
				<input
					// Stable id so the `A` shortcut can open this tab AND land the cursor here —
					// switching to a search box you then have to Tab to is half a shortcut.
					id={ASK_INPUT_ID}
					type="text"
					value={question}
					maxLength={QUESTION_MAX_LEN}
					onChange={(e) => setQuestion(e.target.value)}
					placeholder="Ask a question, e.g. top pages last week"
					aria-label="Question"
					className="input flex-1 rounded-lg px-3.5 py-2 text-sm"
				/>
				<button
					type="submit"
					disabled={mutation.isPending || question.trim().length === 0}
					className="rounded-lg btn-accent px-4 py-2 text-sm transition-colors disabled:opacity-50"
				>
					Ask
				</button>
			</form>

			<div className="flex flex-wrap items-center gap-2">
				<span
					data-chrome
					className="font-medium text-[11px] text-[color:var(--faint)] uppercase tracking-wide"
				>
					Answer window
				</span>
				{(['dashboard', ...RANGE_PRESETS] as Scope[]).map((option) => (
					<button
						key={option}
						type="button"
						aria-pressed={scope === option}
						onClick={() => setScope(option)}
						className={
							scope === option
								? 'chip-active rounded-full border px-3 py-1 text-xs'
								: 'btn-ghost rounded-full px-3 py-1 text-xs'
						}
					>
						{option === 'dashboard' ? 'Dashboard range' : PRESET_LABELS[option]}
					</button>
				))}
				<span data-chrome className="text-[color:var(--faint)] text-xs">
					{scope === 'dashboard'
						? 'asks use the range at the top of the page'
						: 'this tab only — the rest of the dashboard is unaffected'}
				</span>
			</div>

			{history.length > 0 ? (
				<div>
					<div className="mb-2 flex items-center justify-between">
						<span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[color:var(--muted)]">
							<History className="h-3.5 w-3.5" aria-hidden="true" />
							Recent questions
						</span>
						<button
							type="button"
							onClick={() => setHistory(clearAskHistory())}
							className="text-xs font-medium text-[color:var(--muted)] underline hover:text-[color:var(--ink)]"
						>
							Clear history
						</button>
					</div>
					<ul className="flex flex-wrap gap-2">
						{history.map((entry) => (
							// Replay and remove are siblings inside one pill: a button nested in a
							// button is invalid, and a chip with no way to drop one bad question
							// forces an all-or-nothing "Clear history".
							<li
								key={entry.question}
								className="inline-flex max-w-xs items-center rounded-full border border-[color:rgb(var(--border))] bg-[var(--panel)] transition-colors hover:border-[color:var(--chip-border)]"
							>
								<button
									type="button"
									onClick={() => run(entry.question)}
									// Chips truncate, so the tooltip is the only way back to the
									// full text of a long question.
									title={entry.question}
									className="min-w-0 truncate py-1 pl-3 text-xs text-[color:var(--ink)]"
								>
									{entry.question}
								</button>
								<span
									data-chrome
									className="shrink-0 px-1.5 text-[10px] text-[color:var(--faint)] tabular-nums"
								>
									{formatAskAge(entry.at)}
								</span>
								<button
									type="button"
									aria-label={`Remove "${entry.question}" from history`}
									onClick={() => setHistory(removeAskHistory(entry.question))}
									className="shrink-0 rounded-full py-1 pr-2.5 pl-0.5 text-[color:var(--faint)] transition-colors hover:text-[color:var(--ink)]"
								>
									<X className="h-3 w-3" aria-hidden="true" />
								</button>
							</li>
						))}
					</ul>
				</div>
			) : null}

			{mutation.isPending ? (
				// A bare "Thinking…" hides where the time goes and, worse, hides that the model step is
				// only a translation step. Naming both stages makes the boundary legible while waiting.
				<div className="surface rounded-xl p-5" aria-live="polite" aria-busy="true">
					<p className="inline-flex items-center gap-2 font-medium text-[color:var(--ink)] text-sm">
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
						{/* The input holds exactly what was submitted (run() writes it back), so it
						    names the in-flight question — `context` still points at the previous
						    answer until this one lands. */}
						Answering "{question}"
					</p>
					<ol
						data-chrome
						className="mt-2 space-y-1 text-[color:var(--muted)] text-xs marker:text-[color:var(--faint)]"
					>
						<li>1. Translating the question into a constrained query shape (model).</li>
						<li>2. Running that query over your aggregates (no model involved).</li>
					</ol>
				</div>
			) : mutation.error instanceof Error ? (
				<div role="alert" className="alert-warn space-y-2 rounded-xl p-5 text-sm">
					<p>{errorHint(mutation.error.message)}</p>
					<Vocabulary />
				</div>
			) : data ? (
				<section className="space-y-4" aria-live="polite">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<p
								data-chrome
								className="font-medium text-[11px] text-[color:var(--faint)] uppercase tracking-wide"
							>
								Computed from your data
							</p>
							<p className="mt-1 font-medium text-[color:var(--ink)] text-sm">
								{data.answer}
							</p>
						</div>
						<CopyAnswer text={buildAnswerText(context.question, context.range, data)} />
					</div>

					{fallback ? (
						<div className="alert-info space-y-2 rounded-xl p-4 text-sm">
							<p className="inline-flex items-center gap-1.5 font-medium">
								<Info className="h-4 w-4 shrink-0" aria-hidden="true" />
								This resolved to the default query: total pageviews.
							</p>
							<p data-chrome className="text-xs">
								That happens when the question can't be mapped onto a supported
								metric or breakdown — so treat the number above as "total
								pageviews", not as an answer to what you asked. Rephrase using one
								of these:
							</p>
							<Vocabulary />
						</div>
					) : null}

					{data.result.kind === 'scalar' ? (
						<Card>
							<p
								data-chrome
								className="font-semibold text-[11px] text-[color:var(--muted)] uppercase tracking-wide"
							>
								{METRIC_LABELS[data.intent.metric]}
							</p>
							<p className="mt-1 text-3xl font-semibold tabular-nums text-[color:var(--ink)]">
								{formatMetricValue(data.intent.metric, data.result.value)}
							</p>
							<p data-chrome className="mt-1 text-[color:var(--faint)] text-xs">
								{data.result.value === 0
									? `No ${METRIC_LABELS[data.intent.metric]} recorded in ${formatWindow(context.range)}.`
									: formatWindow(context.range)}
							</p>
						</Card>
					) : data.result.kind === 'breakdown' ? (
						<TopList
							title={`Top ${DIMENSION_LABELS[data.intent.dimension ?? 'path']}`}
							rows={data.result.rows}
						/>
					) : (
						<TrafficChart series={data.result.points} />
					)}

					{empty ? (
						<p data-chrome className="alert-info rounded-xl p-4 text-sm">
							Nothing was recorded in {formatWindow(context.range)}. Try a wider
							answer window above, or check that the tracker is installed.
						</p>
					) : null}

					<IntentReadout intent={data.intent} range={context.range} />
				</section>
			) : (
				<div className="surface space-y-3 rounded-xl p-6">
					<p className="font-medium text-[color:var(--ink)] text-sm">
						Ask a question about your traffic
					</p>
					<p data-chrome className="text-[color:var(--muted)] text-sm">
						A model reads your question and picks one query shape from a fixed list. It
						never writes SQL and never writes the answer: the server runs that shape
						over your own aggregates, and every number you see comes back from your
						data. The resolved shape is shown with each answer so you can check it.
					</p>
					<Vocabulary />
					<ul className="flex flex-wrap gap-2 pt-1">
						{EXAMPLES.map((example) => (
							<li key={example}>
								<button
									type="button"
									onClick={() => run(example)}
									className="btn-ghost rounded-full px-3 py-1.5 text-sm"
								>
									{example}
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
