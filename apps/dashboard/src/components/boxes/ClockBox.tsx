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

import { type ReactElement, useMemo } from 'react';
import { type ClockFilter, useClock } from '../../hooks/insights.js';
import { formatNumber } from '../../lib/format.js';
import { type Range, useDashboard } from '../../state.js';
import { ErrorState, Skeleton } from '../StatusStates.js';
import {
	CALENDAR_DAY_MS,
	CalendarHeatmap,
	dailyCounts,
	utcDayStart,
} from '../charts/CalendarHeatmap.js';
import { PolarClock, shiftClockCells } from '../charts/PolarClock.js';
import type { TileConfig, TileDef } from './types.js';

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

function ClockBody({
	variant,
	local,
	filter,
}: {
	variant: 'polar' | 'nightingale';
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
			`Shifted client-side from ${data.timezone}; the server never guessed a timezone.`)
		: 'Server-side UTC, unshifted.';

	return (
		<PolarClock
			cells={cells}
			variant={variant === 'nightingale' ? 'nightingale' : 'grid'}
			frameLabel={frameLabel}
			note={note}
		/>
	);
}

function CalendarBody({
	series,
}: {
	series: readonly { t: number; pageviews: number }[];
}): ReactElement {
	const { range, setCustomRange, selection } = useDashboard();
	const counts = useMemo(() => dailyCounts(series), [series]);
	// A custom range exactly one UTC day wide IS the drilled state — the range control is this
	// chart's breadcrumb, so there is no second, private notion of "the selected day" to drift.
	const selectedDay =
		selection.kind === 'custom' && selection.end - selection.start === CALENDAR_DAY_MS
			? utcDayStart(selection.start)
			: null;
	return (
		<CalendarHeatmap
			start={range.start}
			end={range.end}
			counts={counts}
			selectedDay={selectedDay}
			onSelectDay={(day) => setCustomRange(day, day + CALENDAR_DAY_MS)}
		/>
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
	render: (ctx, _expanded, config) => {
		const variant = variantOf(config);
		if (variant === 'calendar') return <CalendarBody series={ctx.series} />;
		return (
			<ClockBody
				variant={variant}
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
