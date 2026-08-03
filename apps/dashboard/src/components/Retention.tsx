// Cohort-retention view. Two readings of the same triangle:
//   • Curve — the weighted-average retention curve (what people actually want to read) with each
//     cohort drawn faintly behind it, so drift between cohorts is visible at a glance.
//   • Triangle — the heatmap table (cohorts as rows, periods as columns), now sortable so "which
//     cohort is best/worst" is answerable, with the cohort column pinned while you scroll sideways.
// Retention depth is bounded by the site's salt window — at the default daily window cross-period
// retention is legitimately ~0, not a bug — so the server `note` is surfaced, but dismissibly: it is
// an explanation you need once, not on every render.

import type { CohortPeriod } from '@facet/shared';
import { ChevronDown, ChevronUp, Info, X } from 'lucide-react';
import { type ReactElement, type ReactNode, useMemo, useState } from 'react';
import { useRetention } from '../hooks/retention.js';
import { cn } from '../lib/cn.js';
import {
	type Movement,
	formatNumber,
	formatPercent,
	formatPoints,
	rateMovement,
} from '../lib/format.js';
import { isAuthError } from '../lib/status.js';
import { DAY_MS, type Range, previousRange } from '../state.js';
import { Card } from './Card.js';
import { SegmentNotice } from './CubeFilterBar.js';
import { DeltaBadge } from './Delta.js';
import {
	AuthErrorBanner,
	CardSkeletons,
	EmptyState,
	ErrorState,
	Skeleton,
} from './StatusStates.js';

/**
 * Below ~30 visitors the normal approximation behind any retention percentage stops holding and a
 * single person moves a cell by more than 3pp, so a 12-visitor cohort at 50% is noise wearing the
 * same colour as a 4,000-visitor cohort at 50%. Cohorts under this size are flagged, excluded from
 * the best/worst ranking, and can be filtered out entirely.
 */
export const LOW_CONFIDENCE_SIZE = 30;

/** `retention[0]` is 1 for every cohort by definition, so the first column that can rank is 1. */
const RANK_PERIOD = 1;

/** Persisted so the salt-window explanation stops re-announcing itself once it has been read. */
const NOTE_STORAGE = 'facet.retention.note-dismissed';

// Five accent-tinted bands over the 0..1 fraction. Each pairs a background with a text color chosen for
// AA contrast against that background, so a cell's value is never conveyed by color alone (the number
// is always shown, and each cell carries a title).
type Band = { bg: string; text: string };

const EMPTY_BAND: Band = {
	bg: 'bg-[color:rgb(var(--hover))]',
	text: 'text-[color:var(--faint)]',
};

// An alpha ramp over the palette's own accent rather than the fixed light-mode accent-50..600 steps,
// which rendered as five shades of near-white on the dark shell. The top band stops at 0.62 so ink-on-
// tint keeps AA contrast in BOTH modes, letting one ramp serve light and dark.
const BANDS: readonly Band[] = [
	{
		bg: 'bg-[color:rgb(var(--accent-rgb)/0.10)]',
		text: 'text-[color:var(--muted)]',
	},
	{
		bg: 'bg-[color:rgb(var(--accent-rgb)/0.20)]',
		text: 'text-[color:var(--ink)]',
	},
	{
		bg: 'bg-[color:rgb(var(--accent-rgb)/0.32)]',
		text: 'text-[color:var(--ink)]',
	},
	{
		bg: 'bg-[color:rgb(var(--accent-rgb)/0.46)]',
		text: 'text-[color:var(--ink)]',
	},
	{
		bg: 'bg-[color:rgb(var(--accent-rgb)/0.62)]',
		text: 'text-[color:var(--ink)]',
	},
];

/** Minimum shape the derived helpers need — a shared `CohortRow` and test fixtures both satisfy it. */
export interface CohortLike {
	cohort: string;
	size: number;
	retention: number[];
}

/**
 * Visitor-weighted average retention for each period column. A plain mean over cohorts would let a
 * 40-visitor cohort swing the curve as hard as a 4,000-visitor one, so each cohort contributes in
 * proportion to its size. Returns null for a column no cohort has reached yet.
 */
export function periodAverages(
	cohorts: { size: number; retention: number[] }[],
	periods: number,
): (number | null)[] {
	return Array.from({ length: periods }, (_, i) => {
		let retained = 0;
		let base = 0;
		for (const c of cohorts) {
			const fraction = c.retention[i];
			if (fraction == null) continue;
			retained += fraction * c.size;
			base += c.size;
		}
		return base > 0 ? retained / base : null;
	});
}

/** Visitors behind a period column — the denominator the weighted average was computed over. */
export function periodBase(cohorts: readonly CohortLike[], period: number): number {
	let base = 0;
	for (const c of cohorts) {
		if (c.retention[period] != null) base += c.size;
	}
	return base;
}

/**
 * 95% confidence half-width for a proportion (normal approximation), in the same 0..1 units as the
 * fraction. Surfaced in cell tooltips so a bright cell over 8 visitors reads as the coin-flip it is.
 */
export function marginOfError(fraction: number, size: number): number | null {
	if (size <= 0) return null;
	const p = Math.min(1, Math.max(0, fraction));
	return 1.96 * Math.sqrt((p * (1 - p)) / size);
}

/**
 * Whether any cohort actually came back after its own period. False is the expected reading at the
 * default daily salt window (every hash is new the next day), and it is what decides whether the
 * page shows a curve at all or explains why there is nothing to plot.
 */
export function hasReturnData(cohorts: readonly { retention: number[] }[]): boolean {
	return cohorts.some((c) => c.retention.some((f, i) => i > 0 && f > 0));
}

/**
 * The period comparison for a cohort triangle — and, as much as anything, the shape it is NOT.
 *
 * "This week vs last week" has no meaning for a cohort row: a row IS a group of people who arrived
 * in one particular week, so there is no counterpart row in the preceding window to hold it against.
 * Putting a delta on the rows would be comparing the January cohort to the March cohort and calling
 * the difference a trend. What DOES compare is the shape of the curve at the same offsets: the
 * visitor-weighted "share still active n periods after arriving" for cohorts that started in this
 * window, against the same figure for cohorts that started in the preceding one. Both windows are the
 * same length, so both triangles are truncated the same way at every offset — offset k in each is
 * averaged over the cohorts that had k periods of room to be seen again.
 *
 * Two rates → percentage POINTS. Offsets where either side is missing, or where either side rests on
 * fewer than `minBase` visitors (one person moves a 30-visitor average by more than 3 points), return
 * null and render nothing.
 */
export function curveComparison(
	current: readonly CohortLike[],
	previous: readonly CohortLike[] | null | undefined,
	periods: number,
	minBase: number = LOW_CONFIDENCE_SIZE,
): (Movement | null)[] {
	if (!previous || previous.length === 0) return Array.from({ length: periods }, () => null);
	const now = periodAverages(current as CohortLike[], periods);
	const before = periodAverages(previous as CohortLike[], periods);
	return Array.from({ length: periods }, (_, i) => {
		const a = now[i];
		const b = before[i];
		if (a == null || b == null) return null;
		if (periodBase(current, i) < minBase || periodBase(previous, i) < minBase) return null;
		return rateMovement(a, b);
	});
}

export type CohortSortKey = 'cohort' | 'size' | number;

export interface CohortSort {
	key: CohortSortKey;
	dir: 'asc' | 'desc';
}

/** Sort a copy of the cohorts. Cohorts too young to have reached a ranked period always sink to the
 * bottom rather than interleaving — a blank cell is "not yet", not "zero". */
export function sortCohorts<T extends CohortLike>(cohorts: readonly T[], sort: CohortSort): T[] {
	const dir = sort.dir === 'asc' ? 1 : -1;
	return [...cohorts].sort((a, b) => {
		if (sort.key === 'cohort') return a.cohort.localeCompare(b.cohort) * dir;
		if (sort.key === 'size') return (a.size - b.size) * dir || a.cohort.localeCompare(b.cohort);
		const av = a.retention[sort.key];
		const bv = b.retention[sort.key];
		if (av == null && bv == null) return a.cohort.localeCompare(b.cohort);
		if (av == null) return 1;
		if (bv == null) return -1;
		return (av - bv) * dir || a.cohort.localeCompare(b.cohort);
	});
}

/**
 * Best and worst cohort at a period column, ignoring cohorts too small to trust and returning null
 * when there is nothing to compare (fewer than two eligible cohorts, or a flat tie). Naming a
 * "best cohort" off a 6-visitor row would be worse than naming none.
 */
export function rankCohorts<T extends CohortLike>(
	cohorts: readonly T[],
	at: number,
	minSize: number = LOW_CONFIDENCE_SIZE,
): { best: T; worst: T } | null {
	const eligible = cohorts.filter((c) => c.size >= minSize && c.retention[at] != null);
	if (eligible.length < 2) return null;
	let best = eligible[0] as T;
	let worst = eligible[0] as T;
	for (const c of eligible) {
		const v = c.retention[at] as number;
		if (v > (best.retention[at] as number)) best = c;
		if (v < (worst.retention[at] as number)) worst = c;
	}
	return best.cohort === worst.cohort ? null : { best, worst };
}

function bandFor(fraction: number): Band {
	if (fraction <= 0) return EMPTY_BAND;
	const idx = Math.min(BANDS.length - 1, Math.floor(fraction * BANDS.length));
	return BANDS[idx] ?? EMPTY_BAND;
}

function periodLabel(period: CohortPeriod): string {
	return period === 'week' ? 'Week' : 'Day';
}

function formatPp(moe: number): string {
	return `±${(moe * 100).toFixed(1)}pp`;
}

function readNoteDismissed(): boolean {
	try {
		return localStorage.getItem(NOTE_STORAGE) === '1';
	} catch {
		return false;
	}
}

function writeNoteDismissed(dismissed: boolean): void {
	try {
		if (dismissed) localStorage.setItem(NOTE_STORAGE, '1');
		else localStorage.removeItem(NOTE_STORAGE);
	} catch {
		// Storage blocked (private mode / disabled cookies) — dismissal just won't survive a reload.
	}
}

function Legend(): ReactElement {
	return (
		<div
			data-chrome
			className="flex items-center gap-2 text-[color:var(--muted)] text-xs"
			aria-hidden="true"
		>
			<span>0%</span>
			<div className="flex overflow-hidden rounded">
				{BANDS.map((band) => (
					<span key={band.bg} className={cn('h-3 w-6', band.bg)} />
				))}
			</div>
			<span>100%</span>
		</div>
	);
}

/** One label/value pair in the summary strip. Labels are chrome; values stay copyable. */
function Stat({
	label,
	value,
	sub,
	tone,
	delta,
}: {
	label: string;
	value: string;
	sub?: string;
	tone?: 'pos' | 'warn';
	delta?: ReactNode;
}): ReactElement {
	return (
		<div className="min-w-0">
			<p
				data-chrome
				className="text-[color:var(--faint)] text-[11px] uppercase tracking-wide"
			>
				{label}
			</p>
			<p
				className={cn(
					'flex items-baseline gap-1.5 truncate font-semibold text-sm tabular-nums',
					tone === 'pos' && 'text-[color:var(--pos)]',
					tone === 'warn' && 'text-[color:var(--warn)]',
					!tone && 'text-[color:var(--ink)]',
				)}
			>
				{value}
				{delta}
			</p>
			{sub ? <p className="truncate text-[color:var(--muted)] text-xs">{sub}</p> : null}
		</div>
	);
}

const CURVE_W = 640;
const CURVE_H = 240;
const PAD_L = 40;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 28;
const PLOT_W = CURVE_W - PAD_L - PAD_R;
const PLOT_H = CURVE_H - PAD_T - PAD_B;
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

/**
 * The retention curve: weighted average in the data hue, every cohort behind it in faint accent
 * (dashed when the cohort is too small to trust). Inline SVG, no chart dependency, matching the
 * Sparkline approach. The SVG is decorative — the numbers it draws are also emitted as a
 * screen-reader table below it, since `svg` is opted out of text selection shell-wide.
 */
function RetentionCurve({
	cohorts,
	periods,
	period,
	previous,
	movements,
}: {
	cohorts: readonly CohortLike[];
	periods: number;
	period: CohortPeriod;
	/** Cohorts that started in the equal-length preceding window, or null when there are none. */
	previous?: readonly CohortLike[] | null;
	/** Per-offset movement, already filtered for the offsets where a comparison is meaningful. */
	movements?: (Movement | null)[];
}): ReactElement {
	const avg = periodAverages(cohorts as CohortLike[], periods);
	const before =
		previous && previous.length > 0 ? periodAverages(previous as CohortLike[], periods) : null;
	const x = (i: number): number =>
		periods <= 1 ? PAD_L + PLOT_W / 2 : PAD_L + (i / (periods - 1)) * PLOT_W;
	const y = (f: number): number => PAD_T + (1 - Math.min(1, Math.max(0, f))) * PLOT_H;
	const points = (values: readonly (number | null | undefined)[]): string =>
		values
			.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
			.filter((p): p is string => p !== null)
			.join(' ');

	// At 12 columns every tick label would collide, so thin them while always keeping the last one.
	const tickEvery = periods > 8 ? 2 : 1;
	const label = periodLabel(period).toLowerCase();

	return (
		<div>
			{/* Uniform scaling (not Sparkline's `preserveAspectRatio="none"`): this chart carries axis
			    text and point markers, which a non-uniform stretch would visibly distort. Height comes
			    from the viewBox ratio, capped so a wide card doesn't turn it into a billboard. */}
			<svg
				viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
				className="h-auto max-h-[320px] w-full"
				aria-hidden="true"
				focusable="false"
			>
				{Y_TICKS.map((t) => (
					<g key={t}>
						<line
							x1={PAD_L}
							x2={CURVE_W - PAD_R}
							y1={y(t)}
							y2={y(t)}
							stroke="rgb(var(--border))"
							strokeWidth="1"
						/>
						<text
							x={PAD_L - 6}
							y={y(t) + 3.5}
							textAnchor="end"
							fontSize="10"
							fill="var(--faint)"
						>
							{Math.round(t * 100)}%
						</text>
					</g>
				))}
				{Array.from({ length: periods }, (_, i) => i)
					.filter((i) => i % tickEvery === 0 || i === periods - 1)
					.map((i) => (
						<text
							key={i}
							x={x(i)}
							y={CURVE_H - PAD_B + 16}
							textAnchor="middle"
							fontSize="10"
							fill="var(--faint)"
						>
							{i}
						</text>
					))}
				{cohorts.map((c) => (
					<polyline
						key={c.cohort}
						points={points(Array.from({ length: periods }, (_, i) => c.retention[i]))}
						fill="none"
						stroke="rgb(var(--accent-rgb)/0.28)"
						strokeWidth="1.25"
						strokeDasharray={c.size < LOW_CONFIDENCE_SIZE ? '3 3' : undefined}
						vectorEffect="non-scaling-stroke"
					/>
				))}
				{before ? (
					<polyline
						points={points(before)}
						fill="none"
						stroke="var(--muted)"
						strokeWidth="2"
						strokeDasharray="5 4"
						strokeLinecap="round"
						strokeLinejoin="round"
						vectorEffect="non-scaling-stroke"
					/>
				) : null}
				<polyline
					points={points(avg)}
					fill="none"
					stroke="var(--d1)"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					vectorEffect="non-scaling-stroke"
				/>
				{avg.map((v, i) =>
					v == null ? null : (
						<circle
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional period columns
							key={i}
							cx={x(i)}
							cy={y(v)}
							r="3"
							fill="var(--d1)"
						>
							<title>{`${label} ${i}: ${formatPercent(v)}`}</title>
						</circle>
					),
				)}
			</svg>
			<div
				data-chrome
				className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[color:var(--muted)] text-xs"
			>
				<span className="inline-flex items-center gap-1.5">
					<span
						className="h-0.5 w-4 rounded"
						style={{ backgroundColor: 'var(--d1)' }}
						aria-hidden="true"
					/>
					Weighted average
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span
						className="h-0.5 w-4 rounded"
						style={{ backgroundColor: 'rgb(var(--accent-rgb) / 0.4)' }}
						aria-hidden="true"
					/>
					Each cohort
				</span>
				{before ? (
					<span className="inline-flex items-center gap-1.5">
						<span
							className="h-0.5 w-4 rounded"
							style={{
								backgroundImage:
									'repeating-linear-gradient(90deg, var(--muted) 0 5px, transparent 5px 9px)',
							}}
							aria-hidden="true"
						/>
						Cohorts from the preceding period
					</span>
				) : null}
				<span className="inline-flex items-center gap-1.5">
					<span
						className="h-0.5 w-4 rounded"
						style={{
							backgroundImage:
								'repeating-linear-gradient(90deg, rgb(var(--accent-rgb) / 0.5) 0 3px, transparent 3px 6px)',
						}}
						aria-hidden="true"
					/>
					Under {LOW_CONFIDENCE_SIZE} visitors
				</span>
			</div>
			<table className="sr-only">
				<caption>
					Weighted-average retention by {label} since first activity, across{' '}
					{cohorts.length} cohorts, with the change against cohorts from the preceding
					period at the same offset.
				</caption>
				<thead>
					<tr>
						<th scope="col">{periodLabel(period)}</th>
						<th scope="col">Retained</th>
						<th scope="col">Vs preceding cohorts</th>
					</tr>
				</thead>
				<tbody>
					{avg.map((v, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional period columns
						<tr key={i}>
							<th scope="row">{i}</th>
							<td>{v == null ? 'no data' : formatPercent(v)}</td>
							<td>
								{movements?.[i]
									? formatPoints(movements[i]?.value ?? 0)
									: 'not comparable'}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** A sortable column header: the whole cell is a button, and the `th` carries `aria-sort`. */
function SortHeader({
	children,
	sortKey,
	sort,
	onSort,
	align = 'center',
	className,
}: {
	children: string;
	sortKey: CohortSortKey;
	sort: CohortSort;
	onSort: (key: CohortSortKey) => void;
	align?: 'left' | 'right' | 'center';
	className?: string;
}): ReactElement {
	const active = sort.key === sortKey;
	const Icon = sort.dir === 'asc' ? ChevronUp : ChevronDown;
	return (
		<th
			scope="col"
			aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
			className={cn('px-0.5 py-1', className)}
		>
			<button
				type="button"
				onClick={() => onSort(sortKey)}
				title={`Sort by ${children}`}
				className={cn(
					'inline-flex w-full items-center gap-0.5 rounded px-1.5 py-0.5 font-medium text-xs tabular-nums transition-colors hover:text-[color:var(--ink)]',
					align === 'left' && 'justify-start',
					align === 'right' && 'justify-end',
					align === 'center' && 'justify-center',
					active ? 'text-[color:var(--chip-ink)]' : 'text-[color:var(--muted)]',
				)}
			>
				{children}
				<Icon
					className={cn('h-3 w-3 shrink-0', !active && 'opacity-0')}
					aria-hidden="true"
				/>
			</button>
		</th>
	);
}

export function Retention({
	apiKey,
	siteId,
	range,
}: {
	apiKey: string;
	siteId: string;
	range: Range;
}): ReactElement {
	const [period, setPeriod] = useState<CohortPeriod>('week');
	const [view, setView] = useState<'curve' | 'triangle'>('curve');
	const [sort, setSort] = useState<CohortSort>({ key: 'cohort', dir: 'asc' });
	const [hideSmall, setHideSmall] = useState(false);
	const [noteDismissed, setNoteDismissed] = useState(readNoteDismissed);
	const { data, error, isLoading, isFetching, refetch } = useRetention(
		apiKey,
		siteId,
		range,
		period,
	);
	// The cohorts that STARTED in the equal-length preceding window. Same hook, so it shares the
	// retention cache: stepping back a period and returning re-reads what is already there. It is the
	// only extra read this tab makes, and it makes it only while this tab is mounted. A failure or an
	// empty result costs nothing — every comparison below then renders as absent.
	const beforeRange = previousRange(range);
	const compare = useRetention(apiKey, siteId, beforeRange, period);
	const previousCohorts = compare.data?.cohorts ?? null;

	const cohorts = data?.cohorts;
	const smallCount = useMemo(
		() => (cohorts ?? []).filter((c) => c.size < LOW_CONFIDENCE_SIZE).length,
		[cohorts],
	);
	// Offering (and honouring) the filter only when it leaves something behind: a sticky `hideSmall`
	// carried across a period toggle must never blank the whole view.
	const canHideSmall = smallCount > 0 && smallCount < (cohorts?.length ?? 0);
	const filtered = hideSmall && canHideSmall;
	const shown = useMemo(
		() =>
			cohorts
				? sortCohorts(
						filtered ? cohorts.filter((c) => c.size >= LOW_CONFIDENCE_SIZE) : cohorts,
						sort,
					)
				: [],
		[cohorts, filtered, sort],
	);
	// The same low-volume filter applies to both sides, or the curve would be compared against a
	// population the reader just excluded.
	const before = useMemo(
		() =>
			previousCohorts && filtered
				? previousCohorts.filter((c) => c.size >= LOW_CONFIDENCE_SIZE)
				: previousCohorts,
		[previousCohorts, filtered],
	);

	const onSort = (key: CohortSortKey): void =>
		setSort((prev) =>
			prev.key === key
				? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
				: // Dates read best oldest-first; magnitudes read best largest-first.
					{ key, dir: key === 'cohort' ? 'asc' : 'desc' },
		);

	const segmented = <T extends string>(
		options: readonly { value: T; label: string }[],
		value: T,
		onChange: (next: T) => void,
	): ReactElement => (
		<div className="inline-flex rounded-lg border border-[color:rgb(var(--border))] p-0.5">
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					onClick={() => onChange(o.value)}
					aria-pressed={value === o.value}
					className={cn(
						// No local focus ring: `focus:outline-none` was suppressing the shell's
						// token-driven focus outline and replacing it with a hardcoded accent-500 ramp.
						'rounded-md px-3 py-1 font-medium text-sm transition-colors',
						value === o.value
							? 'chip-active'
							: 'text-[color:var(--muted)] hover:text-[color:var(--ink)]',
					)}
				>
					{o.label}
				</button>
			))}
		</div>
	);

	const header = (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h2 className="font-semibold text-[color:var(--ink)] text-sm">Cohort retention</h2>
				<p className="text-[color:var(--muted)] text-xs">
					Visitors grouped by the period of their first activity, then the share returning
					later.
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				{segmented(
					[
						{ value: 'curve' as const, label: 'Curve' },
						{ value: 'triangle' as const, label: 'Triangle' },
					],
					view,
					setView,
				)}
				{segmented(
					[
						{ value: 'week' as const, label: 'Weekly' },
						{ value: 'day' as const, label: 'Daily' },
					],
					period,
					setPeriod,
				)}
			</div>
		</div>
	);

	if (error && isAuthError(error)) {
		return <AuthErrorBanner />;
	}
	if (error) {
		return (
			<div className="space-y-4">
				{header}
				<ErrorState
					message="Could not load retention"
					detail={error instanceof Error ? error.message : null}
					onRetry={() => void refetch()}
					retrying={isFetching}
				/>
			</div>
		);
	}
	if (isLoading || !data) {
		return (
			<div className="space-y-4">
				{header}
				<CardSkeletons count={1} />
				<Skeleton className="h-[280px] w-full" />
			</div>
		);
	}

	const maxPeriods = shown.reduce((max, c) => Math.max(max, c.retention.length), 0);
	const label = periodLabel(period);
	const returns = hasReturnData(shown);
	const ranked = rankCohorts(shown, RANK_PERIOD);
	const avg = periodAverages(shown, maxPeriods);
	const rankAvg = avg[RANK_PERIOD];
	const rankBase = periodBase(shown, RANK_PERIOD);
	const rankMoe = rankAvg == null ? null : marginOfError(rankAvg, rankBase);
	const totalVisitors = shown.reduce((acc, c) => acc + c.size, 0);
	const movements = curveComparison(shown, before, maxPeriods);
	const comparable = movements.some((m) => m !== null);

	const note = noteDismissed ? (
		<button
			type="button"
			onClick={() => {
				setNoteDismissed(false);
				writeNoteDismissed(false);
			}}
			className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[color:var(--muted)] text-xs hover:text-[color:var(--ink)]"
		>
			<Info className="h-3.5 w-3.5" aria-hidden="true" />
			Why is retention near zero?
		</button>
	) : (
		<div role="note" className="alert-info flex items-start gap-2 rounded-lg p-3 text-sm">
			<Info className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--info)]" aria-hidden="true" />
			<span className="min-w-0 flex-1">{data.note}</span>
			<button
				type="button"
				onClick={() => {
					setNoteDismissed(true);
					writeNoteDismissed(true);
				}}
				aria-label="Dismiss the salt-window note"
				title="Dismiss — you can reopen this from the link that replaces it"
				className="-m-1 shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100"
			>
				<X className="h-4 w-4" aria-hidden="true" />
			</button>
		</div>
	);

	if (data.cohorts.length === 0) {
		return (
			<div className="space-y-4">
				{header}
				<SegmentNotice tab="retention" />
				{note}
				<EmptyState title="No cohorts in this range">
					No visitor had a first-activity period inside this window. If the range does
					cover traffic, the site's salt window is the usual cause: visitor hashes rotate
					each window, so there is nothing to group into a cohort until sessions land
					inside one.
				</EmptyState>
			</div>
		);
	}

	const controls = (
		<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
			{canHideSmall ? (
				<button
					type="button"
					onClick={() => setHideSmall((v) => !v)}
					aria-pressed={hideSmall}
					className={cn(
						'rounded-md border border-[color:rgb(var(--border))] px-2 py-1 font-medium text-xs transition-colors',
						hideSmall
							? 'chip-active'
							: 'text-[color:var(--muted)] hover:text-[color:var(--ink)]',
					)}
				>
					Hide cohorts under {LOW_CONFIDENCE_SIZE} ({smallCount})
				</button>
			) : (
				<span />
			)}
			{view === 'triangle' ? <Legend /> : <span />}
		</div>
	);

	// Stating the shape of the comparison beats implying one. Which rows can be compared — and which
	// deliberately cannot — is not something a reader should have to infer from where badges appear.
	const comparisonNote = (
		<p data-chrome className="mb-3 text-[color:var(--faint)] text-xs">
			{comparable
				? `Compared with cohorts that started in the preceding ${formatNumber(
						Math.round((range.end - range.start) / DAY_MS),
					)} days, at the same ${label.toLowerCase()} offsets. Individual cohorts are not compared: each is one group of visitors, with no counterpart in that window.`
				: `No comparable preceding cohorts${compare.isError ? ' (that read failed)' : ''}, so this shows one period only. A comparison appears once both windows hold cohorts of ${LOW_CONFIDENCE_SIZE}+ visitors at the same offset.`}
		</p>
	);

	return (
		<div className="space-y-4">
			{header}
			{/* The retention endpoint validates path/country/device/channel and then discards them —
			    cohortRetention scopes by site + range only. Accepting a parameter is not applying it,
			    so this tab states plainly that the triangle below is site-wide. */}
			<SegmentNotice tab="retention" />
			{note}

			{/* A named region so the headline numbers are reachable directly, not only by walking the
			    table — and so "best cohort" is an answer the page gives rather than one you derive. */}
			<section
				aria-label="Retention summary"
				className="surface-2 grid grid-cols-2 gap-4 rounded-xl p-4 sm:grid-cols-4"
			>
				<Stat label="Cohorts" value={formatNumber(shown.length)} />
				<Stat label="Visitors" value={formatNumber(totalVisitors)} />
				{rankAvg == null ? (
					<Stat
						label={`Returned at ${label.toLowerCase()} ${RANK_PERIOD}`}
						value="—"
						sub="no cohort has reached it"
					/>
				) : (
					<Stat
						label={`Returned at ${label.toLowerCase()} ${RANK_PERIOD}`}
						value={formatPercent(rankAvg)}
						delta={
							<DeltaBadge
								movement={movements[RANK_PERIOD] ?? null}
								variant="text"
								size="sm"
							/>
						}
						sub={
							rankMoe == null
								? undefined
								: `${formatPp(rankMoe)} over ${formatNumber(rankBase)} visitors`
						}
					/>
				)}
				{ranked ? (
					<div className="grid grid-cols-2 gap-3">
						<Stat
							label="Best"
							tone="pos"
							value={formatPercent(ranked.best.retention[RANK_PERIOD] as number)}
							sub={ranked.best.cohort}
						/>
						<Stat
							label="Weakest"
							tone="warn"
							value={formatPercent(ranked.worst.retention[RANK_PERIOD] as number)}
							sub={ranked.worst.cohort}
						/>
					</div>
				) : (
					<Stat
						label="Best / weakest"
						value="—"
						sub={`needs 2+ cohorts of ${LOW_CONFIDENCE_SIZE}+ visitors`}
					/>
				)}
			</section>

			<Card>
				{controls}
				{returns ? comparisonNote : null}
				{view === 'curve' ? (
					returns ? (
						<RetentionCurve
							cohorts={shown}
							periods={maxPeriods}
							period={period}
							previous={before}
							movements={movements}
						/>
					) : (
						<div className="px-2 py-10 text-center">
							<p className="font-semibold text-[color:var(--ink)] text-sm">
								Nothing to plot beyond {label.toLowerCase()} 0
							</p>
							<p className="mx-auto mt-1 max-w-prose text-[color:var(--muted)] text-sm">
								Every cohort is 100% at {label.toLowerCase()} 0 by definition, and
								no cohort was seen again afterwards. At the default daily salt
								window that is the honest answer, not missing data — widen the salt
								window to measure return visits across periods.
							</p>
						</div>
					)
				) : (
					<div className="max-h-[70vh] overflow-auto">
						<table className="w-full border-separate border-spacing-1 text-sm">
							<caption className="sr-only">
								Cohort retention heatmap: each row is a cohort, each column is the
								number of {label.toLowerCase()}s after their first activity, and
								each cell is the fraction of that cohort still active. Column
								headers sort the table. Individual cohorts carry no period
								comparison — a cohort is one group of visitors and has no
								counterpart in the preceding window; the final row compares the
								weighted average against cohorts that started then.
							</caption>
							<thead className="sticky top-0 z-20 bg-[var(--panel)]">
								<tr>
									<SortHeader
										sortKey="cohort"
										sort={sort}
										onSort={onSort}
										align="left"
										className="sticky left-0 z-30 bg-[var(--panel)] shadow-[4px_0_0_0_var(--panel)]"
									>
										Cohort
									</SortHeader>
									<SortHeader
										sortKey="size"
										sort={sort}
										onSort={onSort}
										align="right"
									>
										Size
									</SortHeader>
									{Array.from({ length: maxPeriods }, (_, i) => (
										<SortHeader
											// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional period columns
											key={i}
											sortKey={i}
											sort={sort}
											onSort={onSort}
										>
											{`${label} ${i}`}
										</SortHeader>
									))}
								</tr>
							</thead>
							<tbody>
								{shown.map((row) => {
									const small = row.size < LOW_CONFIDENCE_SIZE;
									const rank =
										ranked?.best.cohort === row.cohort
											? 'best'
											: ranked?.worst.cohort === row.cohort
												? 'worst'
												: null;
									return (
										<tr key={row.cohort}>
											<th
												scope="row"
												className="sticky left-0 z-10 whitespace-nowrap bg-[var(--panel)] px-2 py-1 text-left font-medium text-[color:var(--ink)] shadow-[4px_0_0_0_var(--panel)]"
											>
												<span className="inline-flex items-center gap-1.5">
													<span>{row.cohort}</span>
													{rank ? (
														<span
															data-chrome
															className={cn(
																'rounded px-1 py-px text-[10px] font-semibold uppercase',
																rank === 'best'
																	? 'badge-pos'
																	: 'badge-warn',
															)}
														>
															{rank}
														</span>
													) : null}
												</span>
											</th>
											<td
												className={cn(
													'px-2 py-1 text-right text-xs tabular-nums',
													small
														? 'text-[color:var(--warn)]'
														: 'text-[color:var(--muted)]',
												)}
												title={
													small
														? `Only ${formatNumber(row.size)} visitors — percentages in this row are noisy`
														: undefined
												}
											>
												{formatNumber(row.size)}
												{small ? (
													<span data-chrome className="ml-1">
														low n
													</span>
												) : null}
											</td>
											{Array.from({ length: maxPeriods }, (_, i) => {
												const fraction = row.retention[i];
												if (fraction == null) {
													return (
														// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional period columns
														<td key={i} className="px-1 py-1" />
													);
												}
												const band = bandFor(fraction);
												const pct = formatPercent(fraction);
												const moe = marginOfError(fraction, row.size);
												return (
													<td
														// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional period columns
														key={i}
														className={cn(
															'rounded-md px-2 py-1 text-center font-medium text-xs tabular-nums',
															band.bg,
															band.text,
															small && 'opacity-70',
														)}
														title={`${row.cohort}, ${label.toLowerCase()} ${i}: ${pct} of ${formatNumber(row.size)} visitors${moe == null ? '' : ` (${formatPp(moe)})`}`}
													>
														{pct}
													</td>
												);
											})}
										</tr>
									);
								})}
							</tbody>
							<tfoot>
								<tr className="border-[color:rgb(var(--border))] border-t">
									<th
										scope="row"
										className="sticky left-0 z-10 whitespace-nowrap bg-[var(--panel)] px-2 pt-2 text-left font-semibold text-[color:var(--muted)] text-xs shadow-[4px_0_0_0_var(--panel)]"
									>
										Weighted average
									</th>
									<td className="px-2 pt-2 text-right text-[color:var(--muted)] text-xs tabular-nums">
										{formatNumber(totalVisitors)}
									</td>
									{avg.map((value, i) => (
										<td
											// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional period columns
											key={i}
											className="px-2 pt-2 text-center font-semibold text-[color:var(--ink)] text-xs tabular-nums"
										>
											{value == null ? '' : formatPercent(value)}
										</td>
									))}
								</tr>
								{/* The comparison belongs on the AVERAGE row and nowhere else: an
								    individual cohort has no counterpart in the preceding window
								    (see `curveComparison`), which the caption above states. */}
								{comparable ? (
									<tr>
										<th
											scope="row"
											className="sticky left-0 z-10 whitespace-nowrap bg-[var(--panel)] px-2 pt-1 text-left font-medium text-[color:var(--muted)] text-xs shadow-[4px_0_0_0_var(--panel)]"
										>
											vs preceding cohorts
										</th>
										<td className="px-2 pt-1 text-right text-[color:var(--faint)] text-xs tabular-nums">
											{formatNumber(
												(before ?? []).reduce((acc, c) => acc + c.size, 0),
											)}
										</td>
										{movements.map((movement, i) => (
											<td
												// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional period columns
												key={i}
												className="px-2 pt-1 text-center text-xs"
											>
												<DeltaBadge
													movement={movement}
													variant="text"
													size="sm"
												/>
											</td>
										))}
									</tr>
								) : null}
							</tfoot>
						</table>
					</div>
				)}
			</Card>
		</div>
	);
}
