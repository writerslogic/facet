// Ask view: a plain-English analytics question box. On submit it POSTs to /api/stats/query and
// renders the constrained answer — a scalar as a big number, or a breakdown reusing TopList. The
// ai_unavailable error is surfaced with a specific hint about enabling the AI binding.

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useNlQuery } from '../hooks/query.js';
import type { Range } from '../state.js';
import { TopList } from './TopList.js';
import { TrafficChart } from './TrafficChart.js';

const numberFormat = new Intl.NumberFormat('en-US');

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
	const mutation = useNlQuery(apiKey, siteId, range);
	const result = mutation.data;

	return (
		<div className="space-y-6">
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					const trimmed = question.trim();
					if (trimmed.length > 0) mutation.mutate(trimmed);
				}}
			>
				<input
					type="text"
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					placeholder="Ask a question, e.g. top pages last week"
					aria-label="Question"
					className="flex-1 rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800 shadow-sm focus:border-sky-500 focus:outline-none"
				/>
				<button
					type="submit"
					disabled={mutation.isPending}
					className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-50"
				>
					Ask
				</button>
			</form>

			{mutation.isPending ? (
				<p className="text-sm text-neutral-400">Thinking…</p>
			) : mutation.error instanceof Error ? (
				<p className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-700">
					{errorHint(mutation.error.message)}
				</p>
			) : result ? (
				<section className="space-y-4">
					<p className="text-sm font-medium text-neutral-700">{result.answer}</p>
					{result.result.kind === 'scalar' ? (
						<div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
							<p className="text-3xl font-semibold tabular-nums text-neutral-900">
								{numberFormat.format(result.result.value)}
							</p>
						</div>
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
