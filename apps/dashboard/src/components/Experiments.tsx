// Experiments view: explicit, labeled experiment AND goal selectors (never a silent first pick),
// then a per-variant table of exposures / conversions / rate / p-value with a "significant" badge.
// Missing prerequisites link to Settings; a deleted/unavailable selection degrades without crashing.

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useExperimentResult, useExperiments } from '../hooks/experiments.js';
import { useGoals } from '../hooks/funnels.js';
import { useFreshness } from '../hooks/stats.js';
import { isAuthError } from '../lib/status.js';
import type { Range } from '../state.js';
import {
	AuthErrorBanner,
	CardSkeletons,
	EmptyState,
	ErrorState,
	PendingNotice,
} from './StatusStates.js';

const numberFormat = new Intl.NumberFormat('en-US');
const percentFormat = new Intl.NumberFormat('en-US', {
	style: 'percent',
	maximumFractionDigits: 1,
});

export function Experiments({
	apiKey,
	siteId,
	range,
	onOpenSettings,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
	onOpenSettings: () => void;
}): ReactElement {
	const experiments = useExperiments(apiKey, siteId);
	const goals = useGoals(apiKey, siteId);
	const freshness = useFreshness(apiKey, siteId, range);
	const [selectedExp, setSelectedExp] = useState<string | null>(null);
	const [selectedGoal, setSelectedGoal] = useState<string | null>(null);

	const expList = experiments.data?.experiments ?? [];
	const goalList = goals.data?.goals ?? [];

	// Preserve the selection while it exists; fall back safely if it was deleted.
	const expExists = selectedExp != null && expList.some((e) => e.id === selectedExp);
	const goalExists = selectedGoal != null && goalList.some((g) => g.id === selectedGoal);
	const experimentId = expExists ? selectedExp : (expList[0]?.id ?? '');
	const goalId = goalExists ? selectedGoal : (goalList[0]?.id ?? '');
	const goal = goalList.find((g) => g.id === goalId) ?? null;
	const result = useExperimentResult(apiKey, siteId, experimentId, goal, range);

	useEffect(() => {
		if (selectedExp != null && !expExists) setSelectedExp(null);
	}, [selectedExp, expExists]);
	useEffect(() => {
		if (selectedGoal != null && !goalExists) setSelectedGoal(null);
	}, [selectedGoal, goalExists]);

	if (
		(experiments.error && isAuthError(experiments.error)) ||
		(goals.error && isAuthError(goals.error))
	) {
		return <AuthErrorBanner />;
	}

	if (experiments.isLoading || goals.isLoading) {
		return <CardSkeletons count={2} />;
	}

	if (experiments.error) {
		return (
			<ErrorState
				message="Could not load experiments"
				detail={experiments.error instanceof Error ? experiments.error.message : null}
			/>
		);
	}

	if (expList.length === 0) {
		return (
			<EmptyState title="No experiments yet">
				<button
					type="button"
					onClick={onOpenSettings}
					className="font-medium text-accent-600 underline hover:text-accent-800"
				>
					Create an experiment in Settings
				</button>
			</EmptyState>
		);
	}

	if (goalList.length === 0) {
		return (
			<EmptyState title="A goal is required">
				<span>
					Measuring an experiment needs a conversion goal.{' '}
					<button
						type="button"
						onClick={onOpenSettings}
						className="font-medium text-accent-600 underline hover:text-accent-800"
					>
						Create a goal in Settings
					</button>
					.
				</span>
			</EmptyState>
		);
	}

	return (
		<div className="space-y-6">
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label
						htmlFor="exp-select"
						className="block text-xs font-medium text-neutral-600"
					>
						Experiment
					</label>
					<select
						id="exp-select"
						value={experimentId}
						onChange={(e) => setSelectedExp(e.target.value)}
						className="mt-1 block w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-800 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
					>
						{expList.map((exp) => (
							<option key={exp.id} value={exp.id}>
								{exp.name}
							</option>
						))}
					</select>
				</div>
				<div>
					<label
						htmlFor="goal-select"
						className="block text-xs font-medium text-neutral-600"
					>
						Conversion goal
					</label>
					<select
						id="goal-select"
						value={goalId}
						onChange={(e) => setSelectedGoal(e.target.value)}
						className="mt-1 block w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-800 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
					>
						{goalList.map((g) => (
							<option key={g.id} value={g.id}>
								{g.name}
							</option>
						))}
					</select>
				</div>
			</div>

			{freshness.data?.pending ? <PendingNotice /> : null}

			<section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
				<h3 className="mb-3 text-sm font-medium text-neutral-500">Variant Results</h3>
				{result.isLoading || !result.data ? (
					<CardSkeletons count={2} />
				) : (
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
				)}
			</section>
		</div>
	);
}
