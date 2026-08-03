// Funnel visualization: pure CSS/SVG horizontal bars (no chart library, to keep the bundle small).
//
// The point of a funnel is finding the leak, and the old chart made you do that arithmetic yourself:
// it showed a per-step count and a drop-off percentage in identical grey, with no indication of which
// step was the problem. Now each row carries BOTH rates that matter — share of the funnel's entrants,
// and step-over-step conversion from the row above — the worst step is called out explicitly with the
// number of people lost there, and bar colour tracks health so the shape is readable at a glance.
//
// Three things the reader still had to work out by hand, now computed here:
//   * the absolute loss per step, which used to hide in a `title` tooltip (invisible on touch);
//   * what the leak is *worth* — how many extra completions a fix would buy (`funnelUpside`);
//   * whether any of this is better or worse than the preceding period (`stepDeltas`).

import type { FunnelReportResult } from '@facet/shared';
import { Target, TrendingDown } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/cn.js';
import { formatNumber, formatPercent, rateMovement, senseOf } from '../lib/format.js';
import { DeltaBadge } from './Delta.js';

interface Step {
	index: number;
	label: string;
	count: number;
	/** Share of the people who entered the funnel (step 1) that reached this step. */
	shareOfEntry: number;
	/** Conversion from the immediately preceding step; null on the first step. */
	stepRate: number | null;
	/** People who reached the previous step but not this one; null on the first step. */
	lost: number | null;
}

/** Derive both rates plus the absolute loss for every step. Exported for unit testing. */
export function funnelSteps(report: FunnelReportResult): Step[] {
	const entry = report.steps[0]?.count ?? 0;
	return report.steps.map((step, i) => {
		const prev = i > 0 ? report.steps[i - 1]?.count : undefined;
		return {
			index: step.index,
			label: step.match_value,
			count: step.count,
			shareOfEntry: entry > 0 ? step.count / entry : 0,
			stepRate: prev != null && prev > 0 ? step.count / prev : null,
			lost: prev != null ? Math.max(0, prev - step.count) : null,
		};
	});
}

/** The step that loses the most people in absolute terms — where fixing something pays most. */
export function worstStep(steps: Step[]): Step | null {
	let worst: Step | null = null;
	for (const s of steps) {
		if (s.lost == null || s.lost <= 0) continue;
		if (!worst || s.lost > (worst.lost ?? 0)) worst = s;
	}
	return worst;
}

/** What fixing the worst step is worth, in completed funnels. */
export interface FunnelUpside {
	/** The step to fix (the one losing the most people). */
	step: Step;
	/** The best step-over-step rate this funnel already achieves somewhere — a proven-reachable bar. */
	targetRate: number;
	/** Extra completions if `step` converted at `targetRate`, carried through the steps below it. */
	gain: number;
}

/**
 * Size the prize: if the worst step converted as well as this funnel's *best* step already does, how
 * many more people would finish? The target is a rate the funnel demonstrably hits somewhere, not an
 * invented benchmark, and rescued users still have to clear every downstream step at today's rates —
 * so the number is a defensible ceiling rather than a fantasy. Null when there is nothing to gain.
 */
export function funnelUpside(steps: Step[]): FunnelUpside | null {
	const worst = worstStep(steps);
	if (!worst) return null;
	const at = steps.findIndex((s) => s.index === worst.index);
	const entering = steps[at - 1]?.count ?? 0;
	if (entering <= 0) return null;

	// Cap at 1 defensively: the server counts a step as reached only if every step above it was, so a
	// rate above 1 shouldn't occur — but if one ever did, it must not inflate the target.
	let targetRate = 0;
	for (const s of steps) {
		if (s.stepRate == null) continue;
		targetRate = Math.max(targetRate, Math.min(1, s.stepRate));
	}
	const current = worst.stepRate ?? 0;
	if (targetRate <= current) return null;

	// Rescued users still have to clear every step below, at today's rates — clamped the same way, so
	// the estimate can never promise more completions than people saved.
	let downstream = 1;
	for (const s of steps.slice(at + 1)) downstream *= Math.min(1, s.stepRate ?? 0);
	const gain = Math.round((targetRate - current) * entering * downstream);
	if (gain < 1) return null;
	return { step: worst, targetRate, gain };
}

/** One step's movement against the same step in the preceding period. */
export interface StepDelta {
	/** current − previous people reaching this step. */
	count: number;
	/** Step-over-step conversion change in fractional points; null when either period has no rate. */
	rate: number | null;
}

/**
 * Align the current steps with the preceding period's, by step index rather than array position, so
 * an edited funnel definition can't silently compare step 2 against step 3. Returns one entry per
 * current step (null where the previous period has no matching step).
 */
export function stepDeltas(steps: Step[], previous: Step[] | null): (StepDelta | null)[] {
	if (!previous || previous.length === 0) return steps.map(() => null);
	const before = new Map(previous.map((s) => [s.index, s]));
	return steps.map((s) => {
		const was = before.get(s.index);
		if (!was) return null;
		return {
			count: s.count - was.count,
			rate: s.stepRate != null && was.stepRate != null ? s.stepRate - was.stepRate : null,
		};
	});
}

/** Bar hue by step-over-step health: green holds, amber leaks, red hemorrhages. */
function toneFor(stepRate: number | null): string {
	if (stepRate == null) return 'var(--d1)';
	if (stepRate >= 0.7) return 'var(--pos)';
	if (stepRate >= 0.4) return 'var(--warn)';
	return 'var(--neg)';
}

/** A funnel that reported no steps at all, or one nobody entered — distinct causes, distinct copy. */
function DegenerateFunnel({ steps }: { steps: Step[] }): ReactElement {
	if (steps.length === 0) {
		return (
			<div className="py-6 text-center">
				<p className="text-[color:var(--muted)] text-sm">This funnel has no steps</p>
				<p data-chrome className="mt-1 text-[color:var(--faint)] text-xs">
					Add at least two steps to it in Settings.
				</p>
			</div>
		);
	}
	return (
		<div className="py-6 text-center">
			<p className="text-[color:var(--muted)] text-sm">No one entered this funnel</p>
			<p data-chrome className="mt-1 text-[color:var(--faint)] text-xs">
				Nobody matched step 1 (<span className="font-mono">{steps[0]?.label}</span>) in this
				range. Widen the date range, or check that the step's match value is right.
			</p>
		</div>
	);
}

export function FunnelChart({
	report,
	previous,
}: {
	report: FunnelReportResult;
	/** The same funnel over the equal-length preceding window, when it has loaded. */
	previous?: FunnelReportResult | null;
}): ReactElement {
	const steps = funnelSteps(report);
	const worst = worstStep(steps);
	const upside = funnelUpside(steps);
	const deltas = stepDeltas(steps, previous ? funnelSteps(previous) : null);
	const entry = steps[0]?.count ?? 0;
	// Two rates → percentage POINTS, through the same movement model the rest of the app uses.
	const overall = previous ? rateMovement(report.overall_rate, previous.overall_rate) : null;

	return (
		<section className="surface rounded-xl p-5">
			<div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
				{/* h2: a sibling top-level section of the Funnels tab, like Goal conversions. */}
				<h2 className="font-medium text-[color:var(--muted)] text-sm">Funnel</h2>
				<span className="text-[color:var(--muted)] text-sm">
					Overall{' '}
					<span className="font-semibold text-[color:var(--ink)] tabular-nums">
						{formatPercent(report.overall_rate)}
					</span>
					{steps.length > 0 ? (
						<span className="ml-2 text-[color:var(--faint)] text-xs tabular-nums">
							{formatNumber(steps.at(-1)?.count ?? 0)} of{' '}
							{formatNumber(steps[0]?.count ?? 0)}
						</span>
					) : null}
					{overall ? (
						<span className="ml-2 inline-flex items-baseline gap-1">
							<DeltaBadge movement={overall} variant="text" size="sm" />
							<span data-chrome className="text-[color:var(--faint)] text-[10px]">
								vs previous
							</span>
						</span>
					) : null}
				</span>
			</div>

			{steps.length === 0 || entry === 0 ? (
				<DegenerateFunnel steps={steps} />
			) : (
				<>
					{worst ? (
						<p
							className={cn(
								'alert-warn flex items-start gap-2 rounded-lg p-3 text-sm',
								// The upside callout stacks directly under it when there is one.
								upside ? 'mb-3' : 'mb-4',
							)}
						>
							<TrendingDown className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
							<span>
								Biggest drop-off at step {worst.index + 1} (
								<strong>{worst.label}</strong>): {formatNumber(worst.lost ?? 0)}{' '}
								lost, only {formatPercent(worst.stepRate ?? 0)} of the previous step
								continued.
							</span>
						</p>
					) : null}

					{upside ? (
						<p className="alert-info mb-4 flex items-start gap-2 rounded-lg p-3 text-sm">
							<Target className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
							<span>
								Lift step {upside.step.index + 1} to{' '}
								{formatPercent(upside.targetRate)} — this funnel's best step — and
								about <strong>{formatNumber(upside.gain)}</strong> more would
								complete it.
							</span>
						</p>
					) : null}

					{steps.length === 1 ? (
						<p data-chrome className="mb-3 text-[color:var(--faint)] text-xs">
							A one-step funnel has no drop-off to measure.
						</p>
					) : null}

					<ol className="space-y-3">
						{steps.map((step, i) => {
							const tone = toneFor(step.stepRate);
							const isWorst = worst != null && worst.index === step.index;
							const delta = deltas[i] ?? null;
							return (
								<li key={step.index}>
									<div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
										<span className="min-w-0 truncate text-[color:var(--ink)]">
											<span className="mr-2 text-[color:var(--faint)] tabular-nums">
												{step.index + 1}.
											</span>
											{step.label}
										</span>
										<span className="flex shrink-0 items-baseline gap-2.5 tabular-nums">
											{step.stepRate !== null ? (
												<span
													className={cn(
														'text-xs',
														isWorst
															? 'font-semibold'
															: 'text-[color:var(--muted)]',
													)}
													style={isWorst ? { color: tone } : undefined}
												>
													{formatPercent(step.stepRate)} continued
												</span>
											) : null}
											<span className="font-semibold text-[color:var(--ink)]">
												{formatNumber(step.count)}
											</span>
										</span>
									</div>
									<div className="h-2.5 w-full overflow-hidden rounded-full bg-[color:rgb(var(--hover))]">
										<div
											className="h-full rounded-full transition-[width] duration-500 ease-out"
											style={{
												width: `${step.shareOfEntry * 100}%`,
												backgroundImage: `linear-gradient(90deg, ${tone}, color-mix(in srgb, ${tone} 55%, transparent))`,
												boxShadow: `0 0 14px -4px ${tone}`,
											}}
											data-testid="funnel-bar"
										/>
									</div>
									<div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[11px] tabular-nums">
										<span className="text-[color:var(--faint)]">
											{formatPercent(step.shareOfEntry)} of everyone who
											entered
										</span>
										<span className="flex items-baseline gap-2.5">
											{/* The absolute loss used to live in a `title` tooltip, so it
											    was unreachable on touch and invisible when scanning. */}
											{step.lost != null && step.lost > 0 ? (
												<span className="text-neg">
													−{formatNumber(step.lost)} lost here
												</span>
											) : null}
											{delta ? (
												delta.rate !== null ? (
													<DeltaBadge
														// Already a difference of two rates, so it is
														// points — the value goes in as-is.
														movement={{
															kind: 'points',
															value: delta.rate,
															sense: senseOf(delta.rate),
														}}
														variant="text"
														size="sm"
													/>
												) : (
													// Step 1 has no rate to compare, so its movement
													// is the change in people entering.
													<span className="inline-flex items-baseline gap-1">
														<DeltaBadge
															movement={{
																kind: 'count',
																value: delta.count,
																sense: senseOf(delta.count),
															}}
															variant="text"
															size="sm"
														/>
														<span
															data-chrome
															className="text-[color:var(--faint)] text-[10px]"
														>
															entered
														</span>
													</span>
												)
											) : null}
										</span>
									</div>
								</li>
							);
						})}
					</ol>
				</>
			)}
		</section>
	);
}
