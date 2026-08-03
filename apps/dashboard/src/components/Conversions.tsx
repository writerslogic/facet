// Goal conversions: one row per goal with its conversion count and rate over the active range.
// Empty state links to Settings ("Create a goal in Settings"); loading/error states are explicit.
//
// Rows used to be three runs of plain text, so comparing two goals meant reading digits. Each row now
// carries a proportional bar scaled to the best-converting goal, which makes relative performance
// legible without changing what the numbers mean.
//
// Each row also owns its own query, and those had no failure path: a rejected conversions request sat
// on an em dash forever, indistinguishable from "still loading" and from "genuinely zero". A failed
// row now says so and offers a retry. Rows also compare against the equal-length preceding window,
// because a 3% conversion rate only reads as good or bad next to what it was.

import type { Goal } from '@facet/shared';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useConversions } from '../hooks/funnels.js';
import { formatNumber, formatPercent, rateMovement } from '../lib/format.js';
import { type Range, previousRange } from '../state.js';
import { DeltaBadge } from './Delta.js';
import { CardSkeletons, EmptyState, ErrorState } from './StatusStates.js';

function GoalRow({
	apiKey,
	siteId,
	goal,
	range,
	comparisonRange,
	peakRate,
	onRate,
}: {
	apiKey: string;
	siteId: string;
	goal: Goal;
	range: Range;
	/** Equal-length window immediately before `range`, for the per-goal trend. */
	comparisonRange: Range;
	/** Best rate across all goals, so every bar is scaled to the same reference. */
	peakRate: number;
	onRate: (id: string, rate: number) => void;
}): ReactElement {
	const { data, isError, error, isFetching, refetch } = useConversions(
		apiKey,
		siteId,
		goal.id,
		range,
	);
	const before = useConversions(apiKey, siteId, goal.id, comparisonRange);
	const rate = data?.rate ?? 0;
	// Report upward so the section can scale all bars to the strongest goal. In an effect, not during
	// render — a setState in the render phase here would re-render every sibling row on every pass.
	useEffect(() => {
		if (data) onRate(goal.id, rate);
	}, [data, rate, goal.id, onRate]);
	const width = peakRate > 0 ? Math.min(100, (rate / peakRate) * 100) : 0;
	// Rate movement is percentage POINTS, not percent-of-percent (see rateMovement). A failed or
	// still-loading comparison yields null and the row simply shows no movement.
	const movement = data && before.data ? rateMovement(data.rate, before.data.rate) : null;

	return (
		<li className="py-2.5">
			<div className="flex items-baseline justify-between gap-3 text-sm">
				<span className="min-w-0 truncate text-[color:var(--ink)]">
					{goal.name}
					<span className="ml-2 text-[color:var(--faint)] text-xs">
						{goal.type}: {goal.match_value}
					</span>
				</span>
				{isError ? (
					<span className="flex shrink-0 items-baseline gap-2">
						<span
							className="badge-neg rounded-full px-2 py-0.5 text-[11px]"
							title={error instanceof Error ? error.message : undefined}
						>
							Unavailable
						</span>
						<button
							type="button"
							onClick={() => void refetch()}
							disabled={isFetching}
							className="btn-ghost rounded-md px-2 py-0.5 text-xs"
						>
							{isFetching ? 'Retrying…' : 'Retry'}
						</button>
					</span>
				) : (
					<span className="flex shrink-0 items-baseline gap-2.5 tabular-nums">
						<DeltaBadge movement={movement} variant="text" size="sm" />
						<span className="text-[color:var(--muted)] text-xs">
							{data ? formatNumber(data.conversions) : '—'}
						</span>
						<span className="font-semibold text-[color:var(--ink)]">
							{data ? formatPercent(rate) : ''}
						</span>
					</span>
				)}
			</div>
			{data && !isError ? (
				<div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[color:rgb(var(--hover))]">
					<div
						className="h-full rounded-full transition-[width] duration-500 ease-out"
						style={{
							width: `${width}%`,
							backgroundImage:
								'linear-gradient(90deg, var(--d1), color-mix(in srgb, var(--d1) 50%, transparent))',
							boxShadow: '0 0 12px -4px var(--d1)',
						}}
					/>
				</div>
			) : null}
		</li>
	);
}

export function Conversions({
	apiKey,
	siteId,
	goals,
	range,
	loading,
	error,
	onRetry,
	retrying,
	onOpenSettings,
}: {
	apiKey: string;
	siteId: string;
	goals: Goal[];
	range: Range;
	loading?: boolean;
	error?: unknown;
	/** Re-run the goals catalog query — a failure here used to leave the whole section dead. */
	onRetry?: () => void;
	retrying?: boolean;
	onOpenSettings: () => void;
}): ReactElement {
	// Each goal's rate arrives from its own query, so the shared scale is collected as they land.
	const [rates, setRates] = useState<Record<string, number>>({});
	const peakRate = Math.max(0, ...Object.values(rates));
	const onRate = useCallback((id: string, rate: number): void => {
		setRates((prev) => (prev[id] === rate ? prev : { ...prev, [id]: rate }));
	}, []);
	// Derived per render like the range itself; React Query hashes the key by value, not identity.
	const comparisonRange = previousRange(range);

	return (
		<section className="surface rounded-xl p-5">
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
				{/* h2: a top-level section of the Funnels tab, directly under its h1. */}
				<h2 className="font-medium text-[color:var(--muted)] text-sm">Goal conversions</h2>
				{goals.length > 0 ? (
					<span data-chrome className="text-[color:var(--faint)] text-xs">
						Conversions per visitor over the selected range; points vs the preceding
						period
					</span>
				) : null}
			</div>
			{loading ? (
				<CardSkeletons count={2} />
			) : error ? (
				<ErrorState
					message="Could not load goals"
					detail={error instanceof Error ? error.message : null}
					onRetry={onRetry}
					retrying={retrying}
				/>
			) : goals.length === 0 ? (
				<EmptyState
					title="No goals yet"
					action={
						<button
							type="button"
							onClick={onOpenSettings}
							className="btn-accent rounded-lg px-3.5 py-1.5 text-sm transition"
						>
							Create a goal in Settings
						</button>
					}
				>
					A goal marks an event or page that counts as success, so Facet can report its
					conversion rate.
				</EmptyState>
			) : (
				<ul className="divide-y divide-[color:rgb(var(--border))]">
					{goals.map((goal) => (
						<GoalRow
							key={goal.id}
							apiKey={apiKey}
							siteId={siteId}
							goal={goal}
							range={range}
							comparisonRange={comparisonRange}
							peakRate={peakRate}
							onRate={onRate}
						/>
					))}
				</ul>
			)}
		</section>
	);
}
