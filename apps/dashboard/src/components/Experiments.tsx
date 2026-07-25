// Experiments view: explicit, labeled experiment AND goal selectors (never a silent first pick),
// then a per-variant table of exposures / conversions / rate / p-value with a "significant" badge.
// Missing prerequisites link to Settings; a deleted/unavailable selection degrades without crashing.

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useExperimentResult, useExperiments } from '../hooks/experiments.js';
import { useGoals } from '../hooks/funnels.js';
import { useFreshness } from '../hooks/stats.js';
import { formatNumber, formatPercent } from '../lib/format.js';
import { isAuthError } from '../lib/status.js';
import type { Range } from '../state.js';
import {
	AuthErrorBanner,
	CardSkeletons,
	EmptyState,
	ErrorState,
	PendingNotice,
} from './StatusStates.js';

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
						className="block text-xs font-medium text-[color:var(--ink)]"
					>
						Experiment
					</label>
					<select
						id="exp-select"
						value={experimentId}
						onChange={(e) => setSelectedExp(e.target.value)}
						className="mt-1 block w-full rounded-lg border border-[color:rgb(var(--border))] px-3 py-1.5 text-sm text-[color:var(--ink)] focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
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
						className="block text-xs font-medium text-[color:var(--ink)]"
					>
						Conversion goal
					</label>
					<select
						id="goal-select"
						value={goalId}
						onChange={(e) => setSelectedGoal(e.target.value)}
						className="mt-1 block w-full rounded-lg border border-[color:rgb(var(--border))] px-3 py-1.5 text-sm text-[color:var(--ink)] focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
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

			<section className="rounded-xl border border-[color:rgb(var(--border))] bg-[var(--panel)] p-5 shadow-sm">
				<h3 className="mb-3 text-sm font-medium text-[color:var(--muted)]">
					Variant Results
				</h3>
				{result.isLoading || !result.data ? (
					<CardSkeletons count={2} />
				) : (
					<table className="w-full text-sm">
						<thead>
							<tr className="text-left text-xs uppercase tracking-wide text-[color:var(--muted)]">
								<th className="py-2">Variant</th>
								<th className="py-2 text-right">Exposures</th>
								<th className="py-2 text-right">Conversions</th>
								<th className="py-2 text-right">Rate</th>
								<th className="py-2 text-right">p-value</th>
								<th className="py-2 text-right">Significant</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-[color:rgb(var(--border))]">
							{result.data.variants.map((row) => (
								<tr key={row.key} className="text-[color:var(--ink)] tabular-nums">
									<td className="py-2 font-medium text-[color:var(--ink)]">
										{row.key}
									</td>
									<td className="py-2 text-right">
										{formatNumber(row.exposures)}
									</td>
									<td className="py-2 text-right">
										{formatNumber(row.conversions)}
									</td>
									<td className="py-2 text-right">{formatPercent(row.rate)}</td>
									<td className="py-2 text-right">
										{row.p_value === null ? '—' : row.p_value.toFixed(4)}
									</td>
									<td className="py-2 text-right">
										{row.significant ? (
											<span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
												significant
											</span>
										) : (
											<span className="text-[color:var(--faint)]">—</span>
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
