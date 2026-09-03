// Experiments view: explicit, labeled experiment AND goal selectors (never a silent first pick),
// the experiment's running/stopped state and age, a verdict banner, a "do we have enough data yet"
// sample-size read, and a per-variant table of exposures / conversions / rate / 95% CI / lift /
// p-value. Missing prerequisites link to Settings; a deleted/unavailable selection degrades without
// crashing.

import type { Experiment, ExperimentResult } from '@facet/shared';
import { AlertTriangle, Clock, Info, Trophy } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useExperimentResult, useExperiments } from '../hooks/experiments.js';
import { useGoals } from '../hooks/funnels.js';
import { useFreshness } from '../hooks/stats.js';
import { formatDay, useClockMode } from '../lib/datetime.js';
import { type Movement, formatNumber, formatPercent, rateMovement } from '../lib/format.js';
import { isAuthError } from '../lib/status.js';
import { type Range, previousRange } from '../state.js';
import { SegmentNotice } from './CubeFilterBar.js';
import { DeltaBadge } from './Delta.js';
import {
	AuthErrorBanner,
	CardSkeletons,
	EmptyState,
	ErrorState,
	PendingNotice,
} from './StatusStates.js';

type Variant = ExperimentResult['variants'][number];

/** Significance level the server calls results at, mirrored here so the UI can't drift from it. */
const ALPHA = 0.05;
/** Two-sided normal quantile for α = 0.05. */
const Z_ALPHA = 1.959964;
/** One-sided normal quantile for 80% power (β = 0.2) — the conventional planning default. */
const Z_POWER = 0.8416212;
const DAY_MS = 86_400_000;

/**
 * Relative change in conversion rate vs the control variant. Null when there's no baseline to
 * compare — and also for a variant with no exposures at all, because 0/0 against a converting
 * control computes as "-100%", which reads as "losing badly" when the truth is "no data yet".
 */
export function liftVsControl(row: Variant, control: Variant | undefined): number | null {
	if (!control || control === row) return null;
	if (control.rate <= 0 || row.exposures === 0) return null;
	return row.rate / control.rate - 1;
}

/**
 * 95% Wilson score interval for a variant's true conversion rate:
 *   centre = (p + z²/2n) / (1 + z²/n)
 *   half   = z/(1 + z²/n) · √( p(1-p)/n + z²/4n² )
 * Wilson rather than the textbook normal (Wald) interval because Wald collapses to zero width at 0%
 * or 100% conversions and undercovers badly at the small counts a young experiment produces —
 * exactly the regime where a reader most needs to see how wide the uncertainty is. Null for an empty
 * arm, where no interval is defined.
 */
export function wilsonInterval(
	conversions: number,
	exposures: number,
): { low: number; high: number } | null {
	if (exposures <= 0) return null;
	const p = conversions / exposures;
	const z2 = Z_ALPHA * Z_ALPHA;
	const denom = 1 + z2 / exposures;
	const centre = (p + z2 / (2 * exposures)) / denom;
	const half =
		(Z_ALPHA / denom) * Math.sqrt((p * (1 - p)) / exposures + z2 / (4 * exposures * exposures));
	// Clamped: a proportion cannot leave [0, 1], and the interval is only ever read as a rate.
	return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Exposures needed *per variant* to call the currently observed difference at 95% two-sided
 * significance with 80% power. Standard two-proportion sample-size formula:
 *   n = ( z_α·√(2·p̄·(1-p̄)) + z_β·√(p₀(1-p₀) + p₁(1-p₁)) )² / (p₁ - p₀)²,   p̄ = (p₀ + p₁)/2
 * Null when either arm is empty or the observed rates are identical (there is no effect size to
 * plan against). It projects from noisy observed rates, so the UI states it as a rough read.
 */
export function requiredExposuresPerVariant(control: Variant, variant: Variant): number | null {
	if (control.exposures === 0 || variant.exposures === 0) return null;
	const p0 = control.rate;
	const p1 = variant.rate;
	const diff = p1 - p0;
	if (diff === 0) return null;
	const pooled = (p0 + p1) / 2;
	const alphaTerm = Z_ALPHA * Math.sqrt(2 * pooled * (1 - pooled));
	const powerTerm = Z_POWER * Math.sqrt(p0 * (1 - p0) + p1 * (1 - p1));
	return Math.ceil((alphaTerm + powerTerm) ** 2 / (diff * diff));
}

/**
 * The smallest absolute rate difference this sample could detect against the control at 95%
 * two-sided significance with 80% power — the test's resolution, and the honest answer to "is this
 * enough data?" even when the arms have separated by nothing at all. Inverts the sample-size formula
 * under the usual planning approximation that both arms share the control's variance:
 *   mde = (z_α + z_β)·√( 2·p₀(1-p₀)/n )
 * Null when the control has no exposures, or no variance to detect against (0% or 100%).
 */
export function detectableEffect(controlRate: number, exposuresPerVariant: number): number | null {
	if (exposuresPerVariant <= 0) return null;
	if (controlRate <= 0 || controlRate >= 1) return null;
	return (
		(Z_ALPHA + Z_POWER) * Math.sqrt((2 * controlRate * (1 - controlRate)) / exposuresPerVariant)
	);
}

/**
 * Probability of at least one false positive when `comparisons` challengers are each tested against
 * the control at α: 1 - (1-α)^k. The comparisons share a control, so they are not independent and
 * this is an approximation — the UI says "roughly". It exists because a 4-variant test quietly
 * triples the chance of a spurious "winner", which no per-row p-value shows.
 */
export function familyWiseErrorRate(comparisons: number, alpha: number = ALPHA): number {
	if (comparisons <= 0) return 0;
	return 1 - (1 - alpha) ** comparisons;
}

/** Bonferroni-adjusted per-comparison threshold for k challengers tested against one control. */
export function adjustedThreshold(comparisons: number, alpha: number = ALPHA): number {
	return comparisons <= 1 ? alpha : alpha / comparisons;
}

/**
 * Whether the preceding window is a window this experiment was actually RUNNING in.
 *
 * A draft created before a selected range may have started halfway through it. Every variant reads
 * zero before that point, and a delta computed against it would report a spectacular improvement
 * that is really just the start date. The experiment must therefore have been active for the whole
 * preceding window. Migrated active rows predate `started_at`, so their creation time is the safe
 * fallback; a zero/absent stamp disqualifies comparison.
 *
 * Returning false does more than hide the badges: the comparison query is not even issued.
 */
export function canComparePeriod(experiment: Experiment | null, before: Range): boolean {
	if (!experiment) return false;
	const startedAt =
		experiment.started_at ?? (experiment.status === 'active' ? experiment.created_at : null);
	return startedAt !== null && startedAt > 0 && startedAt <= before.start;
}

/**
 * Below this many exposures in either window a rate is not stable enough to subtract: at 30
 * exposures one extra conversion moves the rate by more than 3 points, which is larger than most
 * effects being measured. Such a variant shows no movement rather than a number that is mostly noise.
 */
export const MIN_RATE_EXPOSURES = 30;

/**
 * Per-variant rate movement against the same experiment over the preceding window, in percentage
 * POINTS (two rates). Keyed by variant so an edited experiment cannot compare `blue` against `green`.
 * A variant missing from the preceding result, or with too few exposures on either side, is absent.
 */
export function variantMovements(
	current: readonly Variant[],
	previous: readonly Variant[] | null | undefined,
	minExposures: number = MIN_RATE_EXPOSURES,
): Map<string, Movement> {
	const movements = new Map<string, Movement>();
	if (!previous) return movements;
	const before = new Map(previous.map((v) => [v.key, v]));
	for (const row of current) {
		const was = before.get(row.key);
		if (!was) continue;
		if (row.exposures < minExposures || was.exposures < minExposures) continue;
		const movement = rateMovement(row.rate, was.rate);
		if (movement) movements.set(row.key, movement);
	}
	return movements;
}

/**
 * The headline read on the test. A table of p-values asks the reader to work out what it means; this
 * states it: which variant leads, by how much, and — crucially — whether that is yet distinguishable
 * from noise. "No winner yet" is a real, useful answer and is stated as one rather than left
 * implicit, and a winner that only clears the unadjusted bar in a multi-variant test is flagged
 * rather than crowned.
 */
function ExperimentVerdict({ variants }: { variants: Variant[] }): ReactElement | null {
	if (variants.length < 2) return null;
	const control = variants[0];
	if (!control) return null;
	const challengers = variants.slice(1);
	const exposures = variants.reduce((acc, v) => acc + v.exposures, 0);

	// Nothing measured at all is an instrumentation/range question, not a "keep waiting" answer.
	if (exposures === 0) {
		return (
			<div className="alert-warn flex items-start gap-2.5 rounded-lg p-3 text-sm">
				<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
				<span>
					<strong>No exposures in this range.</strong> Nobody has been bucketed into a
					variant yet — check that the site is firing exposure events for this flag, or
					widen the date range.
				</span>
			</div>
		);
	}

	// The significant variant with the highest rate, if any has separated from the control.
	const winner = challengers.filter((v) => v.significant).sort((a, b) => b.rate - a.rate)[0];

	if (!winner) {
		// A variant with no exposures isn't "behind" — it has nothing to say, so it can't lead.
		const best = challengers.filter((v) => v.exposures > 0).sort((a, b) => b.rate - a.rate)[0];
		const lift = best ? liftVsControl(best, control) : null;
		return (
			<div className="alert-info flex items-start gap-2.5 rounded-lg p-3 text-sm">
				<Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
				<span>
					<strong>No significant difference yet.</strong>{' '}
					{best && lift !== null ? (
						<>
							{best.key} is {lift >= 0 ? 'ahead' : 'behind'} by{' '}
							{Math.abs(lift * 100).toFixed(1)}%, but that could still be noise.{' '}
						</>
					) : null}
					{formatNumber(exposures)} exposures so far — keep the test running.
				</span>
			</div>
		);
	}

	const lift = liftVsControl(winner, control);
	// With k challengers there are k chances to clear p < 0.05 by luck. A "winner" that fails the
	// Bonferroni-adjusted bar is the classic multiple-comparisons trap, so it is shown as a caution
	// rather than a green light.
	const threshold = adjustedThreshold(challengers.length);
	const unadjusted =
		challengers.length > 1 && winner.p_value !== null && winner.p_value > threshold;
	return (
		<div
			className={`${unadjusted ? 'alert-warn' : 'alert-ok'} flex items-start gap-2.5 rounded-lg p-3 text-sm`}
		>
			{unadjusted ? (
				<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			) : (
				<Trophy className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			)}
			<span>
				<strong>{winner.key}</strong> is {unadjusted ? 'ahead' : 'winning'}
				{lift !== null ? (
					<>
						{' '}
						with a {lift > 0 ? '+' : ''}
						{(lift * 100).toFixed(1)}% lift over {control.key}
					</>
				) : null}
				{winner.p_value !== null ? <> (p = {winner.p_value.toFixed(4)})</> : null}. Based on{' '}
				{formatNumber(exposures)} exposures.
				{unadjusted ? (
					<>
						{' '}
						With {challengers.length} challengers tested at once, that p-value is weaker
						than it looks: the Bonferroni-adjusted bar here is {threshold.toFixed(4)}.
					</>
				) : null}
			</span>
		</div>
	);
}

/**
 * "Do we have enough data?" — the question a table of p-values never answers. States the resolution
 * of the sample actually collected (the smallest gap it could detect) and, while a leading
 * challenger has not separated, roughly how many more exposures its observed gap would need.
 */
function SampleSizeNote({ variants }: { variants: Variant[] }): ReactElement | null {
	const control = variants[0];
	if (!control) return null;
	const measured = variants.filter((v) => v.exposures > 0);
	if (measured.length === 0) return null;

	// Power is set by the limiting arm, so the read is sized against the smallest one.
	const smallest = Math.min(...measured.map((v) => v.exposures));
	const mde = detectableEffect(control.rate, smallest);

	const leader = variants
		.slice(1)
		.filter((v) => v.exposures > 0)
		.sort((a, b) => b.rate - a.rate)[0];
	const needed =
		leader && !leader.significant ? requiredExposuresPerVariant(control, leader) : null;
	const remaining = needed === null ? 0 : Math.max(0, needed - smallest);
	if (mde === null && remaining === 0) return null;

	return (
		<div className="surface-2 mt-3 rounded-lg p-3 text-[color:var(--muted)] text-xs">
			<span className="font-medium text-[color:var(--ink)]" data-chrome>
				Sample size
			</span>{' '}
			{mde !== null ? (
				<>
					At {formatNumber(smallest)} exposures in the smallest arm, this test can only
					resolve a gap of about {(mde * 100).toFixed(1)} points against the control's{' '}
					{formatPercent(control.rate)} rate (≈{((mde / control.rate) * 100).toFixed(0)}%
					relative). A smaller true difference will keep reading as noise no matter how
					the p-values move.{' '}
				</>
			) : null}
			{remaining > 0 && leader ? (
				<>
					Confirming the gap now showing for <strong>{leader.key}</strong> at 95%
					confidence with 80% power needs roughly {formatNumber(needed ?? 0)} exposures
					per variant — about {formatNumber(remaining)} more each.
				</>
			) : null}
		</div>
	);
}

/**
 * Durable lifecycle and its relevant timestamp. A p-value is unreadable without it: a "no
 * significant difference" on a completed experiment is a final result, while on an active one it
 * remains a progress report.
 */
function ExperimentStatus({ experiment }: { experiment: Experiment | null }): ReactElement | null {
	if (!experiment) return null;
	const statusLabel =
		experiment.status === 'active'
			? 'Running'
			: experiment.status === 'completed'
				? 'Completed'
				: 'Draft';
	const eventLabel =
		experiment.status === 'active'
			? 'started'
			: experiment.status === 'completed'
				? 'completed'
				: 'created';
	const eventAt =
		experiment.status === 'active'
			? (experiment.started_at ?? experiment.created_at)
			: experiment.status === 'completed'
				? (experiment.completed_at ?? experiment.created_at)
				: experiment.created_at;
	const eventMs = eventAt > 0 ? eventAt : null;
	const days = eventMs === null ? null : Math.floor((Date.now() - eventMs) / DAY_MS);
	return (
		<span className="flex items-center gap-2 text-xs">
			<span
				className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
					experiment.status === 'active' ? 'badge-pos' : 'badge-neutral'
				}`}
			>
				{statusLabel}
			</span>
			{eventMs !== null ? (
				<span className="flex items-center gap-1 text-[color:var(--muted)]">
					<Clock className="h-3 w-3" aria-hidden="true" />
					{days !== null && days >= 0 ? (
						<>{days === 0 ? `${eventLabel} today` : `${formatNumber(days)}d ago`} · </>
					) : null}
					{formatDay(eventMs)}
				</span>
			) : null}
		</span>
	);
}

/** Headline read before the statistical table: volume, blended conversion, leading observed lift,
 * and collection health. These are descriptive only; the verdict below owns inferential claims. */
function ExperimentSummary({ variants }: { variants: Variant[] }): ReactElement {
	const exposures = variants.reduce((total, variant) => total + variant.exposures, 0);
	const conversions = variants.reduce((total, variant) => total + variant.conversions, 0);
	const control = variants[0];
	const leader = variants
		.slice(1)
		.filter((variant) => variant.exposures > 0)
		.sort((a, b) => b.rate - a.rate)[0];
	const uplift = leader && control ? liftVsControl(leader, control) : null;
	const health =
		exposures === 0
			? 'No data'
			: variants.some((variant) => variant.exposures === 0)
				? 'Missing arm'
				: Math.min(...variants.map((variant) => variant.exposures)) < MIN_RATE_EXPOSURES
					? 'Collecting'
					: 'Balanced read';
	const items = [
		{ label: 'Total exposures', value: formatNumber(exposures), detail: 'Across all variants' },
		{
			label: 'Total conversions',
			value: formatNumber(conversions),
			detail:
				exposures > 0
					? `${formatPercent(conversions / exposures)} blended rate`
					: 'No exposure base',
		},
		{
			label: 'Leading observed uplift',
			value:
				uplift == null
					? '—'
					: `${leader?.key ?? 'Challenger'} ${uplift > 0 ? '+' : ''}${(uplift * 100).toFixed(1)}%`,
			detail: leader ? `${leader.key} vs control · descriptive` : 'No measured challenger',
		},
		{ label: 'Data health', value: health, detail: 'Read warnings below before deciding' },
	];
	return (
		<dl
			className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
			aria-label="Experiment summary"
		>
			{items.map((item) => (
				<div key={item.label} className="surface rounded-2xl p-5">
					<dt className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--faint)]">
						{item.label}
					</dt>
					<dd className="mt-2 font-semibold text-2xl text-[color:var(--ink)] tabular-nums">
						{item.value}
					</dd>
					<p className="mt-1 text-xs text-[color:var(--muted)]">{item.detail}</p>
				</div>
			))}
		</dl>
	);
}

/** Per-variant table: counts, rate with a proportional bar, Wilson CI, period movement, lift, p-value. */
function VariantTable({
	variants,
	movements,
	comparable,
	detailed,
}: {
	variants: Variant[];
	/** Rate movement vs the preceding window, by variant key. Empty when there is nothing to compare. */
	movements: Map<string, Movement>;
	/** Whether a comparison was even attempted — drives the column's empty-cell explanation. */
	comparable: boolean;
	/** Whether to show the 95% CI column — the one table cell dense enough to gate behind the toggle. */
	detailed: boolean;
}): ReactElement {
	const control = variants[0];
	const peak = Math.max(...variants.map((v) => v.rate), 0);
	const threshold = adjustedThreshold(variants.length - 1);

	return (
		<table className="mt-4 w-full text-sm">
			<thead>
				<tr className="text-left text-[color:var(--muted)] text-xs uppercase tracking-wide">
					<th className="py-2">Variant</th>
					<th className="py-2 text-right">Exposures</th>
					<th className="py-2 text-right">Conversions</th>
					<th className="py-2 text-right">Rate</th>
					{detailed ? (
						<th className="hidden py-2 text-right md:table-cell">95% CI</th>
					) : null}
					<th className="py-2 text-right">Rate vs previous</th>
					<th className="py-2 text-right">Lift vs control</th>
					<th className="py-2 text-right">p-value</th>
				</tr>
			</thead>
			<tbody className="divide-y divide-[color:rgb(var(--border))]">
				{variants.map((row, i) => {
					const lift = liftVsControl(row, control);
					const ci = wilsonInterval(row.conversions, row.exposures);
					const empty = row.exposures === 0;
					return (
						<tr key={row.key} className="text-[color:var(--ink)] tabular-nums">
							<td className="py-2 font-medium text-[color:var(--ink)]">
								{row.key}
								{i === 0 ? (
									<span className="ml-2 rounded badge-neutral px-1.5 py-0.5 font-normal text-[10px] uppercase tracking-wide">
										control
									</span>
								) : null}
								{empty ? (
									<span
										className="ml-2 rounded badge-warn px-1.5 py-0.5 font-normal text-[10px] uppercase tracking-wide"
										data-chrome
									>
										no exposures
									</span>
								) : null}
							</td>
							<td className="py-2 text-right">{formatNumber(row.exposures)}</td>
							<td className="py-2 text-right">{formatNumber(row.conversions)}</td>
							<td className="py-2 text-right">
								{empty ? (
									<span className="text-[color:var(--faint)]">—</span>
								) : (
									<span className="inline-flex items-center justify-end gap-2">
										<span
											aria-hidden="true"
											className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-[color:rgb(var(--hover))] sm:block"
										>
											<span
												className="block h-full rounded-full"
												style={{
													width: `${peak > 0 ? (row.rate / peak) * 100 : 0}%`,
													backgroundColor: row.significant
														? 'var(--pos)'
														: 'var(--d1)',
												}}
											/>
										</span>
										{formatPercent(row.rate)}
									</span>
								)}
							</td>
							{detailed ? (
								<td className="hidden py-2 text-right text-[color:var(--muted)] md:table-cell">
									{ci === null ? (
										<span className="text-[color:var(--faint)]">—</span>
									) : (
										`${(ci.low * 100).toFixed(1)}–${(ci.high * 100).toFixed(1)}%`
									)}
								</td>
							) : null}
							<td className="py-2 text-right">
								{movements.get(row.key) ? (
									<DeltaBadge
										movement={movements.get(row.key)}
										variant="text"
										size="sm"
									/>
								) : (
									<span
										className="text-[color:var(--faint)]"
										title={
											comparable
												? `Needs at least ${MIN_RATE_EXPOSURES} exposures in both windows — fewer than that, a single conversion moves the rate more than most effects being measured.`
												: 'No comparable preceding period for this experiment.'
										}
									>
										—
									</span>
								)}
							</td>
							<td className="py-2 text-right">
								{lift === null ? (
									<span className="text-[color:var(--faint)]">—</span>
								) : (
									<span
										className={
											lift > 0
												? 'text-pos'
												: lift < 0
													? 'text-neg'
													: 'text-[color:var(--muted)]'
										}
									>
										{lift > 0 ? '+' : ''}
										{(lift * 100).toFixed(1)}%
									</span>
								)}
							</td>
							<td className="py-2 text-right">
								{row.p_value === null ? (
									'—'
								) : (
									<span className="inline-flex items-center justify-end gap-1.5">
										{row.p_value.toFixed(4)}
										{row.significant ? (
											<span
												className={`rounded px-1 py-0.5 text-[10px] uppercase tracking-wide ${
													row.p_value > threshold
														? 'badge-warn'
														: 'badge-pos'
												}`}
												data-chrome
											>
												{row.p_value > threshold ? 'unadjusted' : 'sig'}
											</span>
										) : null}
									</span>
								)}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

/**
 * What the "Rate vs previous" column is, or why it is empty. An absent comparison with no
 * explanation reads as a bug; an absent comparison that names its reason is an answer — and on this
 * tab the usual reason (the test started inside the selected range) is itself worth knowing.
 */
function PeriodComparisonNote({
	experiment,
	comparable,
	failed,
}: {
	experiment: Experiment | null;
	comparable: boolean;
	failed: boolean;
}): ReactElement {
	if (comparable && !failed) {
		return (
			<p className="mt-3 text-[color:var(--faint)] text-xs">
				<span data-chrome>Rate vs previous</span> is each variant's conversion rate against
				its own rate over the equal-length window immediately before this one, in percentage
				points. It says whether a result is settling or still drifting; it is not a
				significance test.
			</p>
		);
	}
	const started =
		experiment && experiment.created_at > 0 ? formatDay(experiment.created_at) : null;
	return (
		<p className="mt-3 text-[color:var(--faint)] text-xs">
			{failed
				? 'The preceding period could not be loaded, so no rate comparison is shown.'
				: started
					? `No rate comparison: this experiment started ${started}, so the equal-length window before this range is one it was not running in. Comparing against it would report the start date as a result.`
					: 'No rate comparison: this experiment has no recorded start date, so there is no window it is known to have been running in.'}
		</p>
	);
}

/** How to read the table, including the multiple-comparisons trap once there are 3+ variants. */
function StatsFootnote({ variants }: { variants: Variant[] }): ReactElement {
	const challengers = Math.max(0, variants.length - 1);
	const threshold = adjustedThreshold(challengers);
	return (
		<>
			<p className="mt-3 text-[color:var(--faint)] text-xs">
				Lift is each variant's conversion rate relative to the control (the first variant).
				The 95% CI is a Wilson interval for that variant's own true rate: two intervals that
				don't overlap are a difference you can rely on, but overlapping intervals are not by
				themselves evidence of no difference — read the p-value. A result is called
				significant at p &lt; 0.05; until then a difference may be noise, so keep the test
				running.
			</p>
			{challengers > 1 ? (
				<p className="mt-2 text-[color:var(--faint)] text-xs">
					{challengers} challengers are each compared with the control, so there are{' '}
					{challengers} chances to clear p &lt; 0.05 by luck alone — roughly a{' '}
					{(familyWiseErrorRate(challengers) * 100).toFixed(0)}% chance of at least one
					false positive. Treat p &lt; {threshold.toFixed(4)} (0.05/{challengers}, the
					Bonferroni-adjusted bar) as the threshold for declaring a winner.
				</p>
			) : null}
		</>
	);
}

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
	// Start dates below render in the active clock; subscribe so the header toggle moves them.
	useClockMode();
	const freshness = useFreshness(apiKey, siteId, range);
	const [selectedExp, setSelectedExp] = useState<string | null>(null);
	const [selectedGoal, setSelectedGoal] = useState<string | null>(null);
	// Defaults to the headline read (verdict + core table): Wilson CIs, the sample-size/MDE note, and
	// the multiple-comparisons footnote are real statistics but not what a first-time reader needs to
	// know "did it work" — they're one click away for whoever is checking the test's rigor.
	const [detailed, setDetailed] = useState(false);

	const expList = experiments.data?.experiments ?? [];
	const goalList = goals.data?.goals ?? [];

	// Preserve the selection while it exists; fall back safely if it was deleted.
	const expExists = selectedExp != null && expList.some((e) => e.id === selectedExp);
	const goalExists = selectedGoal != null && goalList.some((g) => g.id === selectedGoal);
	const experimentId = expExists ? selectedExp : (expList[0]?.id ?? '');
	const goalId = goalExists ? selectedGoal : (goalList[0]?.id ?? '');
	const experiment = expList.find((e) => e.id === experimentId) ?? null;
	const goal = goalList.find((g) => g.id === goalId) ?? null;
	const result = useExperimentResult(apiKey, siteId, experimentId, goal, range);
	// The equal-length preceding window — but ONLY when the experiment was already running through
	// all of it. Otherwise the query is never issued: there is no honest delta to be had from a
	// window in which the test did not exist, so paying for the read would buy a lie.
	const beforeRange = previousRange(range);
	const comparable = canComparePeriod(experiment, beforeRange);
	const before = useExperimentResult(apiKey, siteId, experimentId, goal, beforeRange, comparable);

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
				onRetry={() => void experiments.refetch()}
				retrying={experiments.isFetching}
			/>
		);
	}

	if (expList.length === 0) {
		return (
			<EmptyState
				title="No experiments yet"
				action={
					<button
						type="button"
						onClick={onOpenSettings}
						className="btn-accent rounded-lg px-3.5 py-1.5 text-sm transition"
					>
						Create an experiment in Settings
					</button>
				}
			>
				An experiment splits visitors between 2–8 weighted variants and measures each one
				against a conversion goal, with a Wilson interval and a p-value so a difference is
				reported only when the data supports it. Assignment is client-side and cookieless.
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
						className="font-medium text-[color:var(--chip-ink)] underline hover:text-[color:var(--chip-ink)]"
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
			{/* Exposures and conversions are counted site-wide; the endpoint has no dimension params
			    at all, so a filtered-looking header over these rates would be a lie. */}
			<SegmentNotice tab="experiments" />
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
						className="input mt-1 block w-full rounded-lg px-3 py-1.5 text-sm"
					>
						{expList.map((exp) => (
							// A non-active test is still worth reading, but its lifecycle should be
							// visible before selection because its numbers are not currently moving.
							<option key={exp.id} value={exp.id}>
								{exp.status === 'active' ? exp.name : `${exp.name} (${exp.status})`}
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
						className="input mt-1 block w-full rounded-lg px-3 py-1.5 text-sm"
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

			{result.data ? <ExperimentSummary variants={result.data.variants} /> : null}

			<section className="surface rounded-xl p-5">
				<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
					{/* h2: the tab's top-level section, directly under its h1. */}
					<h2 className="text-sm font-medium text-[color:var(--muted)]">
						Variant results
					</h2>
					<div className="flex items-center gap-3">
						<label className="flex items-center gap-1.5 text-[color:var(--muted)] text-xs">
							<input
								type="checkbox"
								checked={detailed}
								onChange={(e) => setDetailed(e.target.checked)}
								className="h-3.5 w-3.5"
							/>
							Statistical detail
						</label>
						<ExperimentStatus experiment={experiment} />
					</div>
				</div>
				{result.isLoading || !result.data ? (
					<CardSkeletons count={2} />
				) : (
					// While a range change refetches, the previous window's numbers stay on screen
					// (see the hook's placeholderData) — dimmed, so they don't read as current.
					<div className={result.isPlaceholderData ? 'opacity-60' : undefined}>
						<ExperimentVerdict variants={result.data.variants} />
						{detailed ? <SampleSizeNote variants={result.data.variants} /> : null}
						<VariantTable
							variants={result.data.variants}
							movements={variantMovements(
								result.data.variants,
								comparable ? (before.data?.variants ?? null) : null,
							)}
							comparable={comparable}
							detailed={detailed}
						/>
						<PeriodComparisonNote
							experiment={experiment}
							comparable={comparable}
							failed={before.isError}
						/>
						{detailed ? <StatsFootnote variants={result.data.variants} /> : null}
					</div>
				)}
			</section>
		</div>
	);
}
