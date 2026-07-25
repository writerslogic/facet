// Time-series chart: a thin React wrapper around uPlot. Plots pageviews + visitors as area-filled
// series with a hovering cursor, readable UTC date/number axes, and a subtle grid. Resizes with a
// ResizeObserver. uPlot needs canvas; if the mount throws (e.g. under jsdom) it degrades gracefully.

import type { SeriesPoint } from '@facet/shared';
import { type ReactElement, useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { formatCompact, formatNumber } from '../lib/format.js';
import { type ThemeColors, useThemeColors } from '../theme.js';
import { Card } from './Card.js';

/** A vertical event marker on the time axis (e.g. a detected anomaly). */
export interface ChartAnnotation {
	/** ms timestamp on the x (time) axis. */
	t: number;
	label?: string;
}

interface TrafficChartProps {
	series: SeriesPoint[];
	loading?: boolean;
	error?: string | null;
	title?: string;
	height?: number;
	/** Vertical markers layered over the series — used to flag anomalies on the timeline. */
	annotations?: ChartAnnotation[];
	/** Render just the fill-height canvas (no Card/header) — for embedding inside a bento tile. */
	bare?: boolean;
}

// The chart's resolved colours (from the active theme): pageviews on `ink`=primary, visitors on
// `accent`=secondary, anomalies on `mark`=accent hue, over a faint token grid.
interface Palette {
	accent: string;
	ink: string;
	grid: string;
	axis: string;
	mark: string;
	pvFill: [string, string];
	visFill: [string, string];
}

/** uPlot plugin: draw a dashed vertical line + top caret at each annotation's time position. Positions
 * come from `valToPos(..., true)` (canvas pixels), matching `u.bbox`, so it aligns at any zoom/size.
 * Reads annotations through a getter so the chart never has to be rebuilt when only they change. */
function annotationPlugin(get: () => ChartAnnotation[], mark: string): uPlot.Plugin {
	return {
		hooks: {
			draw: (u: uPlot) => {
				const annotations = get();
				if (annotations.length === 0) return;
				const { ctx } = u;
				const { left, top, width, height } = u.bbox;
				ctx.save();
				for (const a of annotations) {
					const cx = Math.round(u.valToPos(a.t / 1000, 'x', true));
					if (cx < left || cx > left + width) continue;
					ctx.strokeStyle = mark;
					ctx.globalAlpha = 0.5;
					ctx.lineWidth = 1;
					ctx.setLineDash([4, 3]);
					ctx.beginPath();
					ctx.moveTo(cx, top);
					ctx.lineTo(cx, top + height);
					ctx.stroke();
					ctx.setLineDash([]);
					ctx.globalAlpha = 1;
					ctx.fillStyle = mark;
					ctx.beginPath();
					ctx.moveTo(cx - 4, top);
					ctx.lineTo(cx + 4, top);
					ctx.lineTo(cx, top + 6);
					ctx.closePath();
					ctx.fill();
				}
				ctx.restore();
			},
		},
	};
}

/** uPlot plugin: a floating hover readout (date + each series' exact value) that follows the cursor, so
 * the bare bento chart is explorable without the legend. Reads the hovered index from `u.cursor.idx`. */
function tooltipPlugin(getEl: () => HTMLDivElement | null): uPlot.Plugin {
	const fmtDate = (s: number): string =>
		new Date(s * 1000).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC',
		});
	return {
		hooks: {
			setCursor: (u: uPlot) => {
				const el = getEl();
				if (!el) return;
				const idx = u.cursor.idx;
				if (idx == null || u.cursor.left == null || u.cursor.left < 0) {
					el.style.opacity = '0';
					return;
				}
				const t = u.data[0]?.[idx];
				const pv = u.data[1]?.[idx];
				const vis = u.data[2]?.[idx];
				el.innerHTML = `<div class="mb-1 font-medium text-[11px] text-neutral-400">${t == null ? '' : fmtDate(t)}</div><div class="flex items-center gap-2 text-[12px]"><span class="inline-block size-2 rotate-45 rounded-[1px]" style="background:#f5f3ff"></span><span class="text-neutral-500">Pageviews</span><span class="tabular ml-auto font-semibold text-neutral-900">${pv == null ? '—' : formatNumber(pv)}</span></div><div class="mt-0.5 flex items-center gap-2 text-[12px]"><span class="inline-block size-2 rotate-45 rounded-[1px]" style="background:#818cf8"></span><span class="text-neutral-500">Visitors</span><span class="tabular ml-auto font-semibold text-neutral-900">${vis == null ? '—' : formatNumber(vis)}</span></div>`;
				const left = u.cursor.left;
				const flip = left > u.width / 2;
				el.style.opacity = '1';
				el.style.left = `${left}px`;
				el.style.transform = `translate(${flip ? 'calc(-100% - 14px)' : '14px'}, 8px)`;
			},
		},
	};
}

function buildData(series: SeriesPoint[]): uPlot.AlignedData {
	const x: number[] = [];
	const pageviews: number[] = [];
	const visitors: number[] = [];
	for (const point of series) {
		x.push(point.t / 1000);
		pageviews.push(point.pageviews);
		visitors.push(point.visitors);
	}
	return [x, pageviews, visitors];
}

function fill(
	ctx: CanvasRenderingContext2D,
	from: string,
	to: string,
	bottom: number,
): CanvasGradient {
	const grad = ctx.createLinearGradient(0, 0, 0, bottom);
	grad.addColorStop(0, from);
	grad.addColorStop(1, to);
	return grad;
}

/** Hex (#rrggbb) → rgba string with alpha, for the canvas area fills (which need concrete colours). */
function hexA(hex: string, a: number): string {
	const h = hex.replace('#', '').trim();
	const full =
		h.length === 3
			? h
					.split('')
					.map((c) => c + c)
					.join('')
			: h;
	const n = Number.parseInt(full || '818cf8', 16);
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function ChartCanvas({
	series,
	height,
	annotations,
	colors,
	fillHeight = false,
}: {
	series: SeriesPoint[];
	height: number;
	annotations: ChartAnnotation[];
	colors: ThemeColors;
	fillHeight?: boolean;
}): ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const tooltipRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<uPlot | null>(null);
	const annotationsRef = useRef(annotations);
	annotationsRef.current = annotations;
	const data = useMemo(() => buildData(series), [series]);
	// Latest data for the (rebuild-on-theme) mount effect; data *changes* tween via the effect below.
	const dataRef = useRef(data);
	dataRef.current = data;

	// Annotations are read live via a ref, so changing them redraws in place rather than rebuilding the
	// (canvas-allocating) chart — the mount effect below intentionally omits them from its deps.
	// biome-ignore lint/correctness/useExhaustiveDependencies: redraw must fire when the array changes; the body reads it through the ref
	useEffect(() => {
		if (typeof chartRef.current?.redraw === 'function') chartRef.current.redraw();
	}, [annotations]);

	// Cross-filter / range changes tween the series old→new instead of hard-swapping, so re-slicing the
	// board reads as a smooth transformation rather than a jump. Snaps when the bucket count changes
	// (a different x-axis can't be interpolated) or under reduced-motion.
	// biome-ignore lint/correctness/useExhaustiveDependencies: tween fires on data change; reads the live chart
	useEffect(() => {
		const chart = chartRef.current;
		if (!chart || typeof chart.setData !== 'function') return;
		const to = data;
		const from = chart.data as uPlot.AlignedData;
		const reduce =
			typeof matchMedia !== 'undefined' &&
			matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (from?.[0]?.length !== to[0]?.length || reduce) {
			chart.setData(to);
			return;
		}
		const start = performance.now();
		const DUR = 380;
		let raf = 0;
		const step = (now: number): void => {
			const p = Math.min(1, (now - start) / DUR);
			const e = 1 - (1 - p) ** 3;
			const interp = to.map((seriesArr, si) =>
				si === 0
					? seriesArr
					: (seriesArr as number[]).map((v, i) => {
							const f = (from[si] as number[] | undefined)?.[i] ?? v;
							return f + (v - f) * e;
						}),
			) as uPlot.AlignedData;
			chart.setData(interp);
			if (p < 1) raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, [data]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		// Colours come from the active theme: pageviews on the primary data hue, visitors on the secondary,
		// anomalies on the accent, over a faint token grid.
		const P: Palette = {
			ink: colors.d1,
			accent: colors.d2,
			mark: colors.d3,
			axis: colors.faint,
			grid: colors.grid,
			pvFill: [hexA(colors.d1, 0.22), hexA(colors.d1, 0)],
			visFill: [hexA(colors.d2, 0.3), hexA(colors.d2, 0)],
		};
		const chartHeight = (): number =>
			fillHeight && container.clientHeight > 0 ? container.clientHeight : height;

		const opts: uPlot.Options = {
			width: container.clientWidth || 640,
			height: chartHeight(),
			padding: [12, 8, 0, 8],
			plugins: [
				annotationPlugin(() => annotationsRef.current, P.mark),
				...(fillHeight ? [tooltipPlugin(() => tooltipRef.current)] : []),
			],
			cursor: {
				y: false,
				// A bold hover marker: a filled ring at the hovered value on each series.
				points: { size: 9, width: 2 },
			},
			legend: { show: !fillHeight, live: true },
			series: [
				{
					value: (_u, v) => (v == null ? '—' : new Date(v * 1000).toUTCString()),
				},
				{
					label: 'Pageviews',
					stroke: P.ink,
					width: 2.25,
					fill: (u) => fill(u.ctx, P.pvFill[0], P.pvFill[1], u.bbox.top + u.bbox.height),
					points: { show: false },
					value: (_u, v) => (v == null ? '—' : formatNumber(v)),
				},
				{
					label: 'Visitors',
					stroke: P.accent,
					width: 2.25,
					fill: (u) =>
						fill(u.ctx, P.visFill[0], P.visFill[1], u.bbox.top + u.bbox.height),
					points: { show: false },
					value: (_u, v) => (v == null ? '—' : formatNumber(v)),
				},
			],
			axes: [
				{
					stroke: P.axis,
					grid: { show: false },
					ticks: { stroke: P.grid, size: 4 },
					font: '11px Inter, sans-serif',
					space: 64,
				},
				{
					stroke: P.axis,
					grid: { stroke: P.grid, width: 1 },
					ticks: { show: false },
					font: '11px Inter, sans-serif',
					size: 44,
					values: (_u, splits) => splits.map((v) => formatCompact(v)),
				},
			],
			scales: { x: { time: true } },
		};

		let chart: uPlot | null = null;
		try {
			chart = new uPlot(opts, dataRef.current, container);
		} catch {
			return;
		}
		chartRef.current = chart;

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry && chart)
				chart.setSize({
					width: entry.contentRect.width,
					height: chartHeight(),
				});
		});
		observer.observe(container);

		return () => {
			observer.disconnect();
			chart?.destroy();
			chartRef.current = null;
		};
		// `data` is intentionally omitted: the chart is built once (from dataRef) and data *changes* tween
		// via the effect above, rather than rebuilding the canvas on every filter/range change.
		// biome-ignore lint/correctness/useExhaustiveDependencies: rebuild only on size/theme; data updates are tweened
	}, [height, fillHeight, colors.d1, colors.d2, colors.d3, colors.grid, colors.faint]);

	return (
		<div
			ref={containerRef}
			className={
				fillHeight
					? 'uplot-container chart-hero relative h-full w-full'
					: 'uplot-container w-full'
			}
		>
			{fillHeight ? (
				<div
					ref={tooltipRef}
					className="pointer-events-none absolute top-0 left-0 z-20 rounded-lg border border-neutral-200/70 bg-white/95 px-2.5 py-2 opacity-0 shadow-float ring-1 ring-neutral-900/5 backdrop-blur transition-opacity duration-100"
					aria-hidden="true"
				/>
			) : null}
		</div>
	);
}

export function TrafficChart({
	series,
	loading,
	error,
	title = 'Traffic over time',
	height = 280,
	annotations = [],
	bare = false,
}: TrafficChartProps): ReactElement {
	const colors = useThemeColors();
	if (bare) {
		return series.length === 0 ? (
			<div className="flex h-full items-center justify-center text-sm text-[color:var(--faint)]">
				No data yet
			</div>
		) : (
			<ChartCanvas
				series={series}
				height={height}
				annotations={annotations}
				colors={colors}
				fillHeight
			/>
		);
	}
	return (
		<Card>
			<div className="mb-4 flex items-center justify-between">
				<h3 className="text-[13px] font-semibold uppercase tracking-wide text-neutral-500">
					{title}
				</h3>
				<div className="flex items-center gap-3 text-xs text-neutral-400">
					{annotations.length > 0 ? (
						<span className="inline-flex items-center gap-1">
							<span className="inline-block h-2 w-2 rounded-full bg-rose-500" />
							Anomaly
						</span>
					) : null}
					<span>UTC</span>
				</div>
			</div>
			{loading ? (
				<div
					className="w-full animate-pulse rounded-xl bg-neutral-100"
					style={{ height }}
					aria-hidden="true"
				/>
			) : error ? (
				<div
					className="flex items-center justify-center text-sm text-red-600"
					style={{ height }}
					role="alert"
				>
					{error}
				</div>
			) : series.length === 0 ? (
				<div
					className="flex items-center justify-center text-sm text-neutral-400"
					style={{ height }}
				>
					No data yet
				</div>
			) : (
				<ChartCanvas
					series={series}
					height={height}
					annotations={annotations}
					colors={colors}
				/>
			)}
		</Card>
	);
}
