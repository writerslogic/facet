// Timing box: three readings of "when does traffic actually arrive".
//
//   polar       — the whole 7 × 24 grid as a radial heatmap.
//   nightingale — the same grid collapsed to its hourly marginal, as petals.
//   calendar    — pageviews per UTC day over the range, GitHub-contribution style; click a day and
//                 the board narrows to it.
//
// THE TIMEZONE DECISION lives here rather than in the chart, because it is a product decision, not a
// drawing one. `GET /api/stats/clock` is UTC and refuses to guess a site timezone, so:
//
//   * UTC is the DEFAULT and is named on the chart itself, not only in a legend;
//   * the local view is opt-in, is computed client-side by `shiftClockCells`, and is labelled with
//     the offset it applied (`UTC+2`), never the word "local" alone — "local" is unfalsifiable, an
//     offset is checkable;
//   * a non-whole-hour offset does not get a rounded answer. The grid's resolution is one hour and
//     there is nothing finer to redistribute with, so the toggle reports that and stays on UTC;
//   * a range that straddles a DST change has no single offset. The view still renders — one folded
//     grid can only carry one — but says which offset it used and that the other part of the range
//     sat on a different one.
//
// The calendar stays UTC in every case. Its days must line up with the range control, which parses
// date inputs as UTC day boundaries (`state.ts`), and with the clock grid beside it.
//
// DENSITY. Compact drops both drawings: a 24-sector dial at 100px is a coin, and the calendar's seven
// 13px rows no longer fit. What survives is the question the box exists to answer — when the peak was,
// over the profile it sits in. Expanded keeps the drawing and states that peak in words above it, so
// the answer no longer has to be found by hovering the darkest cell.

import type { ClockCell } from '@facet/shared';
import { type ReactElement, useMemo } from 'react';
import { type ClockFilter, useClock } from '../../hooks/insights.js';
import { formatNumber } from '../../lib/format.js';
import { type Range, useDashboard } from '../../state.js';
import { ErrorState, Skeleton } from '../StatusStates.js';
import {
	CALENDAR_DAY_MS,
	CalendarHeatmap,
	dailyCounts,
	utcDayKey,
	utcDayStart,
} from '../charts/CalendarHeatmap.js';
import { ChartEmpty, ChartNote } from '../charts/ChartChrome.js';
import { PolarClock, hourMarginal, shiftClockCells } from '../charts/PolarClock.js';
import { bandFill, bandOf, intensityThresholds } from '../charts/ramp.js';
import type { TileConfig, TileDef, TileDensity } from './types.js';

const WEEKDAYS = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
] as const;

/** One column of the compact profile. `label` is what the screen-reader table calls it. */
interface StripBar {
	key: string;
	label: string;
	value: number;
}

/** What the viewer's own clock is doing over the range, and whether it can honestly be applied. */
export interface LocalFrame {
	/** Whole hours to add to every UTC hour, or `null` when the shift cannot be done honestly. */
	offsetHours: number | null;
	/** The name every label must use. */
	label: string;
	/** The caveat to print, or `null` when there is nothing to warn about. */
	note: string | null;
}

/**
 * Resolve the local time frame for a range.
 *
 * `getTimezoneOffset` is minutes WEST of UTC, so it is negated to read as the usual "UTC+2". It is
 * sampled at both ends of the range: if they differ, the range crossed a DST boundary and no single
 * offset describes it. The midpoint's offset is used and the disagreement is stated — a folded 7 × 24
 * grid has exactly one hour axis and cannot carry two.
 */
export function localFrame(range: Range): LocalFrame {
	const offsetAt = (ms: number): number => -new Date(ms).getTimezoneOffset();
	const start = offsetAt(range.start);
	const end = offsetAt(range.end);
	const middle = offsetAt((range.start + range.end) / 2);
	const name = (minutes: number): string => {
		const sign = minutes < 0 ? '-' : '+';
		const abs = Math.abs(minutes);
		const hh = Math.floor(abs / 60);
		const mm = abs % 60;
		return `UTC${sign}${hh}${mm === 0 ? '' : `:${String(mm).padStart(2, '0')}`}`;
	};
	if (middle % 60 !== 0) {
		return {
			offsetHours: null,
			label: 'UTC',
			note: `Local time is unavailable here: your offset is ${name(middle)}, and this grid resolves to whole hours only — shifting by a part-hour would need counts inside an hour that the API never returns. Showing UTC.`,
		};
	}
	const note =
		start === end
			? null
			: `This range crosses a daylight-saving change (${name(start)} → ${name(end)}). One folded grid holds one hour axis, so ${name(middle)} was applied to the whole range.`;
	return { offsetHours: middle / 60, label: name(middle), note };
}

type ClockVariant = 'polar' | 'nightingale' | 'calendar';

function variantOf(config: TileConfig | undefined): ClockVariant {
	const value = config?.variant;
	return value === 'nightingale' || value === 'calendar' ? value : 'polar';
}

function wantsLocal(config: TileConfig | undefined): boolean {
	return config?.timezone === 'local';
}

/**
 * The compact rendering every variant falls back to: the peak named on one line, over the profile it
 * came from. The bars carry the same intensity ramp as the two full charts, so this reads as the same
 * chart family rather than a third one, and the frame label rides along — a compact tile must not be
 * the one place on the board where hours appear without saying which clock they are on.
 */
function PeakStrip({
	headline,
	frame,
	value,
	bars,
	columnLabel,
	caption,
	onActivate,
	activateLabel,
}: {
	headline: string;
	frame: string;
	value: number;
	bars: readonly StripBar[];
	columnLabel: string;
	caption: string;
	onActivate?: () => void;
	activateLabel?: string;
}): ReactElement {
	let max = 0;
	for (const bar of bars) max = Math.max(max, bar.value);
	if (max === 0) return <ChartEmpty reason="range" compact />;
	const thresholds = intensityThresholds(bars.map((b) => b.value));

	const head = (
		<>
			<span className="min-w-0 truncate font-medium text-[color:var(--ink)] text-xs">
				{headline}
			</span>
			<span className="ml-auto shrink-0 font-semibold text-[color:var(--ink)] text-sm tabular-nums">
				{formatNumber(value)}
			</span>
			<span className="shrink-0 text-[10px] text-[color:var(--muted)]">{frame}</span>
		</>
	);

	return (
		<div className="flex h-full min-h-0 flex-col justify-center gap-1">
			{onActivate ? (
				<button
					type="button"
					onClick={onActivate}
					className="flex items-center gap-2 rounded-md px-2 py-1 text-left transition hover:bg-[color:rgb(var(--hover))]"
				>
					{head}
					<span className="sr-only">{activateLabel}</span>
				</button>
			) : (
				<div className="flex items-center gap-2 px-2">{head}</div>
			)}
			{/* preserveAspectRatio="none": one column per bucket, whether that is 24 hours or 90 days,
			    with no minimum width to overflow a 232px tile and no tail quietly clipped off. */}
			<svg
				viewBox={`0 0 ${bars.length} 100`}
				preserveAspectRatio="none"
				className="min-h-[12px] w-full flex-1"
				aria-hidden="true"
			>
				{bars.map((bar, index) => {
					const height = Math.max(3, (bar.value / max) * 100);
					const band = bandOf(bar.value, thresholds);
					return (
						<rect
							key={bar.key}
							x={index + 0.12}
							y={100 - height}
							width={0.76}
							height={height}
							fill={band < 0 ? 'rgb(var(--hover))' : bandFill(band)}
						/>
					);
				})}
			</svg>
			<table className="sr-only">
				<caption>{caption}</caption>
				<thead>
					<tr>
						<th scope="col">{columnLabel}</th>
						<th scope="col">Pageviews</th>
					</tr>
				</thead>
				<tbody>
					{bars.map((bar) => (
						<tr key={bar.key}>
							<th scope="row">{bar.label}</th>
							<td>{formatNumber(bar.value)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** The peak stated above an expanded chart, so a focused tile answers "when" without a hover. */
function PeakReadout({
	label,
	value,
	frame,
}: {
	label: string;
	value: number;
	frame: string;
}): ReactElement {
	return (
		<p className="flex shrink-0 items-baseline gap-2 text-xs">
			<span className="font-semibold text-[10px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
				Peak
			</span>
			<span className="min-w-0 truncate font-medium text-[color:var(--ink)]">{label}</span>
			<span className="ml-auto shrink-0 font-semibold text-[color:var(--ink)] tabular-nums">
				{`${formatNumber(value)} pv`}
			</span>
			<span className="shrink-0 text-[10px] text-[color:var(--muted)]">{frame}</span>
		</p>
	);
}

/** The busiest cell of a grid, or null when nothing in it was ever hit. */
function peakCell(cells: readonly ClockCell[]): ClockCell | null {
	const best = cells.reduce<ClockCell | null>(
		(top, cell) => (top === null || cell.pageviews > top.pageviews ? cell : top),
		null,
	);
	return best && best.pageviews > 0 ? best : null;
}

function hourLabel(hour: number): string {
	return `${String(hour).padStart(2, '0')}:00`;
}

function ClockBody({
	variant,
	density,
	local,
	filter,
}: {
	variant: 'polar' | 'nightingale';
	density: TileDensity;
	local: boolean;
	filter: ClockFilter;
}): ReactElement {
	const { apiKey, siteId, range } = useDashboard();
	const { data, error, isLoading } = useClock(apiKey, siteId, range, filter);
	const frame = useMemo(() => localFrame(range), [range]);

	const shift = local ? frame.offsetHours : 0;
	// `cells` is iterated by both the shift and the chart, so a response without it throws inside
	// render — which unmounts the entire dashboard, not this tile. Normalize once, here.
	const cells = useMemo(() => {
		if (!data || !Array.isArray(data.cells)) return null;
		return shift ? shiftClockCells(data.cells, shift) : data.cells;
	}, [data, shift]);

	if (isLoading && !data) return <Skeleton className="h-full w-full" />;
	if (error)
		return <ErrorState message="Could not load the activity clock" detail={String(error)} />;
	if (!data || cells === null) return <ErrorState message="Could not load the activity clock" />;

	// The label always tells the truth about which clock the hours are on, including when the local
	// view was asked for and refused.
	const frameLabel = shift ? frame.label : 'UTC';
	const note = local
		? (frame.note ??
			(frame.offsetHours === 0
				? `Your offset is ${frame.label}, so the local view and the ${data.timezone} the server sent are the same hours.`
				: `Shifted client-side from ${data.timezone}; the server never guessed a timezone.`))
		: 'Server-side UTC, unshifted.';

	if (density === 'compact') {
		const byHour = hourMarginal(cells);
		let peakHour = 0;
		let total = 0;
		byHour.forEach((value, hour) => {
			total += value;
			if (value > (byHour[peakHour] ?? 0)) peakHour = hour;
		});
		return (
			<PeakStrip
				headline={`Peak ${hourLabel(peakHour)}`}
				frame={frameLabel}
				value={byHour[peakHour] ?? 0}
				bars={byHour.map((value, hour) => ({
					key: String(hour),
					label: hourLabel(hour),
					value,
				}))}
				columnLabel={`Hour (${frameLabel})`}
				caption={`Pageviews by hour of day in ${frameLabel}, ${formatNumber(total)} in total; the busiest hour was ${hourLabel(peakHour)}. ${note}`}
			/>
		);
	}

	const chart = (
		<PolarClock
			cells={cells}
			variant={variant === 'nightingale' ? 'nightingale' : 'grid'}
			frameLabel={frameLabel}
			note={note}
		/>
	);
	if (density !== 'expanded') return chart;

	const peak = peakCell(cells);
	if (peak === null) return chart;
	// The nightingale draws hours only, so naming a weekday it does not show would point at a mark
	// that is not there.
	const byHour = hourMarginal(cells);
	const peakHour = byHour.reduce(
		(best, value, hour) => (value > (byHour[best] ?? 0) ? hour : best),
		0,
	);
	return (
		<div className="flex h-full min-h-0 w-full flex-col gap-2">
			{variant === 'nightingale' ? (
				<PeakReadout
					label={hourLabel(peakHour)}
					value={byHour[peakHour] ?? 0}
					frame={frameLabel}
				/>
			) : (
				<PeakReadout
					label={`${WEEKDAYS[peak.day] ?? 'Unknown'} ${hourLabel(peak.hour)}`}
					value={peak.pageviews}
					frame={frameLabel}
				/>
			)}
			<div className="min-h-0 flex-1">{chart}</div>
		</div>
	);
}

function CalendarBody({
	series,
	density,
	local,
}: {
	series: readonly { t: number; pageviews: number }[];
	density: TileDensity;
	local: boolean;
}): ReactElement {
	const { range, setCustomRange, selection } = useDashboard();
	const counts = useMemo(() => dailyCounts(series), [series]);
	const days = useMemo(() => {
		const first = utcDayStart(range.start);
		// `range.end` is exclusive: a range ending at midnight covers up to the previous day.
		const last = utcDayStart(range.end - 1);
		const out: (StripBar & { day: number })[] = [];
		for (let day = first; day <= last; day += CALENDAR_DAY_MS) {
			const key = utcDayKey(day);
			out.push({ key, label: key, value: counts.get(day) ?? 0, day });
		}
		return out;
	}, [range.start, range.end, counts]);
	const busiest = days.reduce<(StripBar & { day: number }) | null>(
		(top, entry) => (top === null || entry.value > top.value ? entry : top),
		null,
	);
	const total = days.reduce((sum, entry) => sum + entry.value, 0);

	if (density === 'compact') {
		return (
			<PeakStrip
				headline={busiest ? `Busiest ${busiest.key}` : 'No days in range'}
				frame="UTC"
				value={busiest?.value ?? 0}
				bars={days}
				columnLabel="Date (UTC)"
				caption={`Pageviews per UTC day, ${formatNumber(total)} across ${days.length} days${
					busiest && busiest.value > 0
						? `; busiest was ${busiest.key} with ${formatNumber(busiest.value)}`
						: ''
				}.`}
				onActivate={
					busiest && busiest.value > 0
						? () => setCustomRange(busiest.day, busiest.day + CALENDAR_DAY_MS)
						: undefined
				}
				activateLabel="Narrow the range to this day"
			/>
		);
	}

	// A custom range exactly one UTC day wide IS the drilled state — the range control is this
	// chart's breadcrumb, so there is no second, private notion of "the selected day" to drift.
	const selectedDay =
		selection.kind === 'custom' && selection.end - selection.start === CALENDAR_DAY_MS
			? utcDayStart(selection.start)
			: null;
	const chart = (
		<CalendarHeatmap
			start={range.start}
			end={range.end}
			counts={counts}
			selectedDay={selectedDay}
			onSelectDay={(day) => setCustomRange(day, day + CALENDAR_DAY_MS)}
		/>
	);
	// The Hours option is offered on every variant but cannot move a calendar day, so the calendar
	// says so rather than leaving the control looking broken.
	const utcNote = local
		? 'Days stay on UTC here: they line up with the range control and the clock grid, so the local-offset setting does not move them.'
		: null;
	const readout =
		density === 'expanded' && busiest && busiest.value > 0 ? (
			<PeakReadout label={busiest.key} value={busiest.value} frame="UTC" />
		) : null;
	if (!utcNote && !readout) return chart;
	return (
		<div className="flex h-full min-h-0 w-full flex-col gap-2">
			{readout}
			<div className="min-h-0 flex-1">{chart}</div>
			{utcNote ? <ChartNote>{utcNote}</ChartNote> : null}
		</div>
	);
}

export const clockBox: TileDef = {
	id: 'timing',
	title: 'When traffic arrives',
	// A dial wants a square plot: at two rows it letterboxed to the tile height and drew a coin.
	size: 'tall',
	expandable: true,
	variants: [
		{ id: 'polar', label: 'Polar grid' },
		{ id: 'nightingale', label: 'Nightingale' },
		{ id: 'calendar', label: 'Calendar' },
	],
	options: [
		{
			key: 'timezone',
			label: 'Hours',
			type: 'select',
			choices: [
				{ value: 'utc', label: 'UTC (as served)' },
				{ value: 'local', label: 'Your local offset' },
			],
			// UTC is the default because it is what the API returned. Defaulting to a client-side
			// shift would put a number on screen the server never computed, under no label.
			default: 'utc',
		},
	],
	table: (ctx) => {
		const counts = dailyCounts(ctx.series);
		return {
			columns: ['Date (UTC)', 'Pageviews'],
			rows: [...counts.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([day, pageviews]) => [new Date(day).toISOString().slice(0, 10), pageviews]),
		};
	},
	render: (ctx, density, config) => {
		const variant = variantOf(config);
		if (variant === 'calendar')
			return (
				<CalendarBody series={ctx.series} density={density} local={wantsLocal(config)} />
			);
		return (
			<ClockBody
				variant={variant}
				density={density}
				local={wantsLocal(config)}
				filter={{
					country: ctx.cubeFilter.country,
					device: ctx.cubeFilter.device,
					channel: ctx.cubeFilter.channel,
				}}
			/>
		);
	},
	action: (ctx) => (
		<span className="text-[10px] text-[color:var(--faint)] tabular-nums">
			{formatNumber(ctx.summary.pageviews)} pv
		</span>
	),
};
