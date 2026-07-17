// Ask view: a plain-English analytics question box. On submit it POSTs to /api/stats/query and
// renders the constrained answer (scalar, breakdown via TopList, or series via TrafficChart). Recent
// questions are kept locally (text + timestamp only) — click to replay, or clear the list.

import { History } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useNlQuery } from '../hooks/query.js';
import {
	type AskEntry,
	clearAskHistory,
	pushAskHistory,
	readAskHistory,
} from '../lib/askHistory.js';
import { formatNumber } from '../lib/format.js';
import type { Range } from '../state.js';
import { Card } from './Card.js';
import { TopList } from './TopList.js';
import { TrafficChart } from './TrafficChart.js';

function errorHint(message: string): string {
	if (message === 'ai_unavailable') {
		return 'Natural-language query needs the AI binding — enable it in wrangler.jsonc and redeploy.';
	}
	return `Something went wrong: ${message}`;
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
	const [history, setHistory] = useState<AskEntry[]>(() => readAskHistory());
	const mutation = useNlQuery(apiKey, siteId, range);
	const result = mutation.data;

	function run(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		setQuestion(trimmed);
		mutation.mutate(trimmed);
		setHistory(pushAskHistory(trimmed));
	}

	return (
		<div className="space-y-6">
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					run(question);
				}}
			>
				<input
					type="text"
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					placeholder="Ask a question, e.g. top pages last week"
					aria-label="Question"
					className="flex-1 rounded-lg border border-neutral-200 px-3.5 py-2 text-sm text-neutral-800 shadow-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
				/>
				<button
					type="submit"
					disabled={mutation.isPending}
					className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700 disabled:opacity-50"
				>
					Ask
				</button>
			</form>

			{history.length > 0 ? (
				<div>
					<div className="mb-2 flex items-center justify-between">
						<span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-neutral-500">
							<History className="h-3.5 w-3.5" aria-hidden="true" />
							Recent questions
						</span>
						<button
							type="button"
							onClick={() => setHistory(clearAskHistory())}
							className="text-xs font-medium text-neutral-500 underline hover:text-neutral-800"
						>
							Clear history
						</button>
					</div>
					<ul className="flex flex-wrap gap-2">
						{history.map((entry) => (
							<li key={entry.at}>
								<button
									type="button"
									onClick={() => run(entry.question)}
									className="inline-flex max-w-xs items-center gap-1 truncate rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-700 transition-colors hover:border-accent-300 hover:bg-accent-50"
								>
									{entry.question}
								</button>
							</li>
						))}
					</ul>
				</div>
			) : null}

			{mutation.isPending ? (
				<p className="text-sm text-neutral-400" aria-live="polite">
					Thinking…
				</p>
			) : mutation.error instanceof Error ? (
				<p
					role="alert"
					className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-700"
				>
					{errorHint(mutation.error.message)}
				</p>
			) : result ? (
				<section className="space-y-4">
					<p className="text-sm font-medium text-neutral-700">{result.answer}</p>
					{result.result.kind === 'scalar' ? (
						<Card>
							<p className="text-3xl font-semibold tabular-nums text-neutral-900">
								{formatNumber(result.result.value)}
							</p>
						</Card>
					) : result.result.kind === 'breakdown' ? (
						<TopList
							title={`Top ${result.intent.dimension ?? ''}`}
							rows={result.result.rows}
						/>
					) : (
						<TrafficChart series={result.result.points} />
					)}
				</section>
			) : (
				<p className="text-sm text-neutral-400">
					Ask a question about your traffic to get started.
				</p>
			)}
		</div>
	);
}
