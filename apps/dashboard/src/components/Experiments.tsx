// Experiments view: pick an experiment + a conversion goal, then render a per-variant table of
// exposures / conversions / rate / p-value with a "significant" badge (vs. the control variant).

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useExperimentResult, useExperiments } from '../hooks/experiments.js';
import { useGoals } from '../hooks/funnels.js';
import { cn } from '../lib/cn.js';
import type { Range } from '../state.js';

const numberFormat = new Intl.NumberFormat('en-US');
const percentFormat = new Intl.NumberFormat('en-US', {
	style: 'percent',
	maximumFractionDigits: 1,
});

export function Experiments({
	apiKey,
	siteId,
	range,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
}): ReactElement {
	const experiments = useExperiments(apiKey, siteId);
	const goals = useGoals(apiKey, siteId);
	const [selectedExp, setSelectedExp] = useState<string | null>(null);
	const [selectedGoal, setSelectedGoal] = useState<string | null>(null);

	const experimentId = selectedExp ?? experiments.data?.experiments[0]?.id ?? '';
	const goalList = goals.data?.goals ?? [];
	const goalId = selectedGoal ?? goalList[0]?.id ?? '';
	const goal = goalList.find((g) => g.id === goalId) ?? null;
	const result = useExperimentResult(apiKey, siteId, experimentId, goal, range);

	if (experiments.data && experiments.data.experiments.length === 0) {
		return (
			<p className="rounded-xl border border-neutral-200 bg-white p-5 text-center text-sm text-neutral-400 shadow-sm">
				No experiments defined. Create one with the admin API.
			</p>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap gap-2">
				{experiments.data?.experiments.map((exp) => (
					<button
						key={exp.id}
						type="button"
						onClick={() => setSelectedExp(exp.id)}
						className={cn(
							'rounded-md border px-3 py-1.5 text-sm transition-colors',
							exp.id === experimentId
								? 'border-sky-500 bg-sky-50 text-sky-700'
								: 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50',
						)}
					>
						{exp.name}
					</button>
				))}
			</div>

			<section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
				<div className="mb-3 flex items-center justify-between">
					<h3 className="text-sm font-medium text-neutral-500">Variant Results</h3>
					{goalList.length > 0 ? (
						<select
							value={goalId}
							onChange={(e) => setSelectedGoal(e.target.value)}
							className="rounded-md border border-neutral-200 px-2 py-1 text-sm text-neutral-700"
						>
							{goalList.map((g) => (
								<option key={g.id} value={g.id}>
									{g.name}
								</option>
							))}
						</select>
					) : null}
				</div>

				{goalList.length === 0 ? (
					<p className="py-6 text-center text-sm text-neutral-400">
						Define a goal to measure conversions.
					</p>
				) : result.data ? (
					<table className="w-full text-sm">
						<thead>
							<tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
								<th className="py-2">Variant</th>
								<th className="py-2 text-right">Exposures</th>
								<th className="py-2 text-right">Conversions</th>
								<th className="py-2 text-right">Rate</th>
								<th className="py-2 text-right">p-value</th>
								<th className="py-2 text-right">Significant</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-neutral-100">
							{result.data.variants.map((row) => (
								<tr key={row.key} className="text-neutral-700 tabular-nums">
									<td className="py-2 font-medium text-neutral-900">{row.key}</td>
									<td className="py-2 text-right">
										{numberFormat.format(row.exposures)}
									</td>
									<td className="py-2 text-right">
										{numberFormat.format(row.conversions)}
									</td>
									<td className="py-2 text-right">
										{percentFormat.format(row.rate)}
									</td>
									<td className="py-2 text-right">
										{row.p_value === null ? '—' : row.p_value.toFixed(4)}
									</td>
									<td className="py-2 text-right">
										{row.significant ? (
											<span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
												significant
											</span>
										) : (
											<span className="text-neutral-300">—</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<p className="py-6 text-center text-sm text-neutral-400">Loading…</p>
				)}
			</section>
		</div>
	);
}
