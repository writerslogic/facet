// Multi-line trend with a selectable focus: one line per dimension value, and picking one brings it
// forward while the rest fade back to context.
//
// The fade is `useSeriesFocus().opacityFor` — 0.18, the shared dim level, so every chart on the board
// emphasises by the same amount. 0.18 rather than 0 on purpose: the unselected lines are still the
// answer to "compared with what", and hiding them would change what the chart says instead of what it
// stresses. The lines cross-fade rather than switch (LinePlot springs each series' alpha), so the
// selection reads as attention moving, not as data being removed.
//
// The legend IS the selector: a row of buttons, so keyboard and pointer take the same path, and the
// label carries the key that colour alone must never carry.

import type { DimensionSeries, Interval } from '@facet/shared';
import { type ReactElement, useCallback, useId, useMemo, useRef } from 'react';
import {
	METRIC_LABEL,
	type SeriesMetric,
	bucketTimes,
	dashOf,
	formatBucket,
	hueOf,
	summarize,
	valuesOf,
} from '../../hooks/timeseries.js';
import { useHoverTarget, useSeriesFocus } from '../../lib/chartInteraction.js';
import { cn } from '../../lib/cn.js';
import { formatNumber } from '../../lib/format.js';
import { useSize } from '../../lib/useSize.js';
import { useThemeColors } from '../../theme.js';
import { ChartEmpty, ChartNote } from './ChartChrome.js';
import { ChartTooltip, TooltipRow } from './ChartTooltip.js';
import { LinePlot, type PlotHandle } from './LinePlot.js';

/** The legend's colour+pattern chip. It draws the line's OWN dash pattern, so the two are matched by
 * shape as well as hue — the muted palette's six hues are close enough that hue alone is not a key. */
function LineSwatch({ color, dash }: { color: string; dash?: number[] }): ReactElement {
	return (
		// No <title>: the chip is decorative (the label beside it carries the key), and a title would
		// put a browser tooltip on every swatch saying nothing the row does not already say.
		<svg width="18" height="8" viewBox="0 0 18 8" aria-hidden="true" className="shrink-0">
			<line
				x1="0"
				y1="4"
				x2="18"
				y2="4"
				stroke={color}
				strokeWidth="2.5"
				strokeDasharray={dash?.join(' ')}
				strokeLinecap="round"
			/>
		</svg>
	);
}

export interface MultiLineProps {
	series: DimensionSeries[];
	interval: Interval;
	metric: SeriesMetric;
	/** What the keys ARE ("Path", "Country"), for the legend heading and the sr-only caption. */
	dimensionLabel: string;
	/** True when the endpoint dropped a tail — the shares below are shares of what is shown. */
	truncated?: boolean;
	/** The drill-down gets room for every legend row; the compact tile scrolls them. */
	expanded?: boolean;
}

/**
 * Below this the tile cannot hold the selected-line detail row, a wrapping legend AND a plot with any
 * height left. Measured, not guessed: the detail row is 20px, a legend row is 22px, the gaps are 16px,
 * and a line chart under ~90px of plot is a scribble. `md` — the smallest size a chart can be resized
 * to — lands at ~118px of content box, which is exactly the case this threshold has to survive.
 */
const COMPACT_HEIGHT = 190;

export function MultiLine({
	series,
	interval,
	metric,
	dimensionLabel,
	truncated = false,
	expanded = false,
}: MultiLineProps): ReactElement {
	const rootRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const plotRef = useRef<PlotHandle | null>(null);
	const size = useSize(containerRef);
	const root = useSize(rootRef);
	// 0 is "not measured yet", not "zero-height": treating the first paint as compact would flash the
	// dense layout in on every mount.
	const compact = root.height > 0 && root.height < COMPACT_HEIGHT && !expanded;
	const theme = useThemeColors();
	const { focused, setFocused, toggle, opacityFor } = useSeriesFocus();
	const legendId = useId();

	const times = useMemo(() => bucketTimes(series), [series]);
	const x = useMemo(() => times.map((t) => t / 1000), [times]);
	const ys = useMemo(
		() => series.map((s) => valuesOf(s, metric, times.length)),
		[series, metric, times.length],
	);
	const colors = useMemo(() => series.map((_s, i) => hueOf(theme.cat, i)), [series, theme.cat]);
	const dashes = useMemo(() => series.map((_s, i) => dashOf(i)), [series]);
	const labels = useMemo(() => series.map((s) => s.key), [series]);
	const alphas = useMemo(() => series.map((s) => opacityFor(s.key)), [series, opacityFor]);
	// Over the whole range: this chart has no window of its own (that is BrushRange's job).
	const rows = useMemo(
		() => summarize(series, metric, 0, times.length - 1),
		[series, metric, times.length],
	);
	const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

	// Pointer → bucket. Asks the canvas rather than recomputing the scale, so the readout cannot
	// disagree with the pixels (and returns null outside the plot area, which clears the hover).
	const resolve = useCallback((localX: number, localY: number): number | null => {
		const plot = plotRef.current;
		const area = plot?.area();
		if (!plot || !area) return null;
		if (
			localX < area.left ||
			localX > area.left + area.width ||
			localY < area.top ||
			localY > area.top + area.height
		) {
			return null;
		}
		return plot.posToIdx(localX - area.left);
	}, []);
	const { hover, handlers } = useHoverTarget(containerRef, resolve);
	const hoverIndex = hover?.datum ?? null;

	const focusedRow = focused == null ? null : rowByKey.get(focused);
	const focusedIndex = focused == null ? -1 : series.findIndex((s) => s.key === focused);

	// Hovered values, ranked, so the tooltip reads top-down like the chart does at that instant.
	const hoverRows = useMemo(() => {
		if (hoverIndex == null) return [];
		return series
			.map((s, i) => ({
				key: s.key,
				value: s.points[hoverIndex]?.[metric] ?? 0,
				color: hueOf(theme.cat, i),
			}))
			.sort((a, b) => b.value - a.value);
	}, [series, hoverIndex, metric, theme.cat]);

	if (series.length === 0) {
		return (
			<ChartEmpty reason="range">
				No {METRIC_LABEL[metric].toLowerCase()} were recorded for any{' '}
				{dimensionLabel.toLowerCase()} in this window.
			</ChartEmpty>
		);
	}

	return (
		<div ref={rootRef} className="flex h-full min-h-0 flex-col gap-2">
			{/* Selected-line detail. Present in the layout at all times (an empty span holds the row)
			    so selecting a line does not shove the chart up by a line's height — except on a tile
			    too short to spend 20px on a hint, where it appears only once there is a selection to
			    report. */}
			<div
				className={cn(
					'flex shrink-0 items-baseline gap-2 text-xs',
					compact ? (focusedRow ? '' : 'hidden') : 'min-h-[1.25rem]',
				)}
			>
				{focusedRow ? (
					<>
						<LineSwatch
							color={hueOf(theme.cat, focusedIndex)}
							dash={dashOf(focusedIndex)}
						/>
						<span className="min-w-0 truncate font-semibold text-[color:var(--ink)]">
							{focusedRow.key}
						</span>
						<span className="tabular-nums text-[color:var(--muted)]">
							{formatNumber(focusedRow.total)} {METRIC_LABEL[metric].toLowerCase()}
						</span>
						<span className="tabular-nums text-[color:var(--faint)]">
							{Math.round(focusedRow.share * 100)}% of shown
						</span>
						<button
							type="button"
							onClick={() => setFocused(null)}
							className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[color:var(--muted)] transition-colors hover:text-[color:var(--ink)]"
						>
							Clear
						</button>
					</>
				) : (
					<span className="text-[color:var(--faint)]">
						Select a {dimensionLabel.toLowerCase()} to bring its line forward
					</span>
				)}
			</div>

			{/* The plot keeps a floor of its own. Without it the two `shrink-0` siblings claimed the
			    whole tile on a short board and `flex-1` resolved to zero — the chart was not small,
			    it was absent, with its own legend sitting where it should have been. */}
			<div
				ref={containerRef}
				className="relative min-h-[5rem] flex-1"
				onPointerMove={handlers.onPointerMove}
				onPointerLeave={handlers.onPointerLeave}
			>
				<LinePlot
					x={x}
					ys={ys}
					colors={colors}
					dashes={dashes}
					labels={labels}
					alphas={alphas}
					crosshair={hoverIndex}
					plotRef={plotRef}
				/>
				{hover != null && times[hover.datum] !== undefined ? (
					<ChartTooltip
						x={hover.x}
						y={hover.y}
						containerWidth={size.width}
						containerHeight={size.height}
					>
						<div className="mb-1 font-medium text-[11px] text-[color:var(--faint)]">
							{formatBucket(times[hover.datum] as number, interval)} UTC
						</div>
						{hoverRows.map((row) => (
							<TooltipRow
								key={row.key}
								label={row.key}
								value={formatNumber(row.value)}
								swatch={row.color}
							/>
						))}
					</ChartTooltip>
				) : null}
			</div>

			{/* The legend doubles as the selector. Buttons, not a listbox: each row is an independent
			    toggle, it is in the tab order on its own, and Enter/Space already do the right thing. */}
			<div className="shrink-0">
				{/* On a short tile the legend heading and the truncation note are the first things to
				    go: the swatches carry the dimension, and the sr-only caption still states it. */}
				{compact ? null : (
					<div className="mb-1 flex items-baseline gap-2">
						<span
							id={legendId}
							className="font-semibold text-[10px] text-[color:var(--muted)] uppercase tracking-[0.08em]"
						>
							{dimensionLabel}
						</span>
						{truncated ? (
							<ChartNote>
								top {series.length} — shares are of these lines, not of all traffic
							</ChartNote>
						) : null}
					</div>
				)}
				<ul
					aria-label={compact ? dimensionLabel : undefined}
					aria-labelledby={compact ? undefined : legendId}
					className={cn(
						'flex gap-x-3',
						// Wrapping needs vertical room the compact tile does not have, so the legend
						// becomes one scrolling row rather than silently losing its tail.
						compact
							? 'flex-nowrap gap-y-0 overflow-x-auto'
							: cn(
									'flex-wrap gap-y-0.5',
									expanded ? '' : 'max-h-[3.25rem] overflow-y-auto',
								),
					)}
				>
					{series.map((s, i) => {
						const row = rowByKey.get(s.key);
						const on = focused === s.key;
						const dimmed = focused != null && !on;
						return (
							<li key={s.key} className={compact ? 'shrink-0' : 'min-w-0'}>
								<button
									type="button"
									aria-pressed={on}
									onClick={() => toggle(s.key)}
									title={s.key}
									className={cn(
										'flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] transition-opacity',
										'hover:bg-[color:rgb(var(--hover))]',
										dimmed ? 'opacity-50' : 'opacity-100',
									)}
								>
									<LineSwatch color={hueOf(theme.cat, i)} dash={dashOf(i)} />
									<span
										className={cn(
											'min-w-0 max-w-[10rem] truncate',
											on
												? 'font-semibold text-[color:var(--ink)]'
												: 'text-[color:var(--muted)]',
										)}
									>
										{s.key}
									</span>
									<span className="tabular-nums text-[color:var(--faint)]">
										{formatNumber(row?.total ?? s.total)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>

			{/* The text equivalent. Same shape as the WorldMap / Sankey tables: these ARE the numbers,
			    so they are selectable and complete for what the chart claims — per-line totals, share
			    and peak. The 8 × 2160 point grid is not reproduced: a table nobody can read is not an
			    equivalent, and the per-bucket values are what the export endpoint is for. */}
			<table className="sr-only">
				<caption>
					{METRIC_LABEL[metric]} by {dimensionLabel.toLowerCase()} over time —{' '}
					{series.length} series across {times.length}{' '}
					{interval === 'hour' ? 'hourly' : 'daily'} buckets.
					{truncated ? ' A longer tail of keys was not returned.' : ''}
				</caption>
				<thead>
					<tr>
						<th scope="col">{dimensionLabel}</th>
						<th scope="col">Total {METRIC_LABEL[metric].toLowerCase()}</th>
						<th scope="col">Share of shown</th>
						<th scope="col">Peak</th>
						<th scope="col">Peak bucket (UTC)</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.key}>
							<th scope="row">{row.key}</th>
							<td>{formatNumber(row.total)}</td>
							<td>{Math.round(row.share * 100)}%</td>
							<td>{formatNumber(row.peak)}</td>
							<td>
								{times[row.peakIndex] === undefined
									? '—'
									: formatBucket(times[row.peakIndex] as number, interval)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
