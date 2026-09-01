// Time-series chart: a thin React wrapper around uPlot. Plots pageviews + visitors as area-filled
// series with a hovering cursor, readable UTC date/number axes, and a subtle grid. Resizes with a
// ResizeObserver. uPlot needs canvas; if the mount throws (e.g. under jsdom) it degrades gracefully.
//
// uPlot is ~145 kB of the bundle and is only needed once a chart actually mounts, so the library is
// imported for its types only and its code is fetched on demand by `loadUPlot`. Its stylesheet stays a
// static import: CSS is extracted into the separately-cached stylesheet, costs no JS, and having it
// present up front stops the chart restyling a frame after it paints.

import type { SeriesPoint, TimelineAnnotationCategory } from '@facet/shared';
import { type ReactElement, useEffect, useMemo, useRef } from 'react';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import {
	clockLabel,
	clockZone,
	formatDayShort,
	formatStamp,
	useClockMode,
} from '../lib/datetime.js';
import { formatCompact, formatNumber } from '../lib/format.js';
import { type ThemeColors, useThemeColors } from '../theme.js';
import { Card } from './Card.js';
import { hexA } from './charts/ramp.js';

// uplot ships `export = uPlot` types over an ESM default export, so the constructor type comes from the
// module type itself while the runtime value comes off `.default`.
type UPlotCtor = typeof import('uplot');

// One in-flight request shared by every chart on the page, so a board with several charts fetches the
// library once and later mounts resolve on the next microtask.
let uplotPending: Promise<UPlotCtor> | null = null;

function loadUPlot(): Promise<UPlotCtor> {
	uplotPending ??= import('uplot').then((m) => m.default);
	return uplotPending;
}

/** A vertical event marker on the time axis, from detection or operator-authored context. */
export interface ChartAnnotation {
	/** ms timestamp on the x (time) axis. */
	t: number;
	label: string;
	kind: 'anomaly' | 'note';
	category?: TimelineAnnotationCategory;
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
	/** Chart style (area/line/bars/smooth), y-scale, a trailing-average overlay, and an accent colour —
	 * the hero's per-instance customization. `zoomable` enables drag-to-zoom (used in the expanded hero). */
	variant?: TrafficVariant;
	scale?: TrafficScale;
	trend?: boolean;
	accent?: string;
	zoomable?: boolean;
}

// The chart's resolved colours (from the active theme): pageviews on `ink`=primary, visitors on
// `accent`=secondary, anomalies on `mark`=accent hue, over a faint token grid.
interface Palette {
	accent: string;
	ink: string;
	grid: string;
	axis: string;
	anomalyMark: string;
	noteMark: string;
	pvFill: [string, string];
	visFill: [string, string];
}

/** uPlot plugin: draw a dashed vertical line + top caret at each annotation's time position. Positions
 * come from `valToPos(..., true)` (canvas pixels), matching `u.bbox`, so it aligns at any zoom/size.
 * Reads annotations through a getter so the chart never has to be rebuilt when only they change. */
function annotationPlugin(
	get: () => ChartAnnotation[],
	marks: { anomaly: string; note: string },
): uPlot.Plugin {
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
					const mark = a.kind === 'note' ? marks.note : marks.anomaly;
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
	const fmtDate = (s: number): string => formatDayShort(s * 1000);
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
				const title = document.createElement('div');
				title.className = 'mb-1 font-medium text-[11px] text-[color:var(--faint)]';
				title.textContent = t == null ? '' : fmtDate(t);
				const metric = (label: string, value: string, color: string, extra = '') => {
					const row = document.createElement('div');
					row.className = `${extra} flex items-center gap-2 text-[12px]`;
					const marker = document.createElement('span');
					marker.className = 'inline-block size-2 rotate-45 rounded-[1px]';
					marker.style.background = color;
					const name = document.createElement('span');
					name.className = 'text-[color:var(--muted)]';
					name.textContent = label;
					const amount = document.createElement('span');
					amount.className = 'tabular ml-auto font-semibold text-[color:var(--ink)]';
					amount.textContent = value;
					row.append(marker, name, amount);
					return row;
				};
				el.replaceChildren(
					title,
					metric('Pageviews', pv == null ? '—' : formatNumber(pv), '#f5f3ff'),
					metric('Visitors', vis == null ? '—' : formatNumber(vis), '#818cf8', 'mt-0.5'),
				);
				const left = u.cursor.left;
				const flip = left > u.width / 2;
				el.style.opacity = '1';
				el.style.left = `${left}px`;
				el.style.transform = `translate(${flip ? 'calc(-100% - 14px)' : '14px'}, 8px)`;
			},
		},
	};
}

/** Trailing moving average over `win` buckets — the optional trend overlay. */
function rollingAvg(values: number[], win: number): number[] {
	const out: number[] = [];
	let sum = 0;
	for (let i = 0; i < values.length; i++) {
		sum += values[i] ?? 0;
		if (i >= win) sum -= values[i - win] ?? 0;
		out.push(sum / Math.min(i + 1, win));
	}
	return out;
}

function buildData(series: SeriesPoint[], trend: boolean): uPlot.AlignedData {
	const x: number[] = [];
	const pageviews: number[] = [];
	const visitors: number[] = [];
	for (const point of series) {
		x.push(point.t / 1000);
		pageviews.push(point.pageviews);
		visitors.push(point.visitors);
	}
	if (trend && pageviews.length > 1) {
		const win = Math.max(3, Math.round(pageviews.length / 8));
		return [x, pageviews, visitors, rollingAvg(pageviews, win)];
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

/** Resolve a `var(--token)` accent to its computed colour — canvas fills/strokes need a concrete colour,
 * not a CSS variable. Non-var inputs (and unresolved tokens) pass through unchanged. */
function resolveVar(el: Element, value: string): string {
	const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
	if (!m?.[1]) return value;
	const resolved = getComputedStyle(el).getPropertyValue(m[1]).trim();
	return resolved || value;
}

/** The hero's selectable chart style. */
export type TrafficVariant = 'area' | 'line' | 'bars' | 'smooth';
/** The hero's y-axis scale option. */
export type TrafficScale = 'linear' | 'log';

function ChartCanvas({
	series,
	height,
	annotations,
	colors,
	fillHeight = false,
	variant = 'area',
	scale = 'linear',
	trend = false,
	accent,
	zoomable = false,
}: {
	series: SeriesPoint[];
	height: number;
	annotations: ChartAnnotation[];
	colors: ThemeColors;
	fillHeight?: boolean;
	variant?: TrafficVariant;
	scale?: TrafficScale;
	trend?: boolean;
	accent?: string;
	zoomable?: boolean;
}): ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const tooltipRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<uPlot | null>(null);
	// A clock change alters the axis ticks, so the canvas has to be rebuilt — hence a dep below rather
	// than a redraw. Toggling the clock is a deliberate, rare action; a chart rebuild is affordable.
	const clock = useClockMode();
	const annotationsRef = useRef(annotations);
	annotationsRef.current = annotations;
	const data = useMemo(() => buildData(series, trend), [series, trend]);
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
		// The chart is built once uPlot's chunk lands. Everything the cleanup has to undo is declared
		// here so it is reachable whether or not the build has run by the time the effect tears down.
		let disposed = false;
		let chart: uPlot | null = null;
		let observer: ResizeObserver | null = null;

		void loadUPlot()
			.then((UPlot) => {
				if (disposed) return;
				// Colours come from the active theme: pageviews on the primary data hue, visitors on the secondary,
				// anomalies on the accent, over a faint token grid.
				// Pageviews take the chosen accent (resolved to a concrete colour — canvas can't read var()); the
				// other series keep the theme's secondary/accent hues.
				const accentHex = accent ? resolveVar(container, accent) : null;
				const pvColor = accentHex ?? colors.d1;
				const P: Palette = {
					ink: pvColor,
					accent: colors.d2,
					anomalyMark: colors.d3,
					noteMark: colors.d2,
					axis: colors.faint,
					grid: colors.grid,
					pvFill: [hexA(pvColor, 0.22), hexA(pvColor, 0)],
					visFill: [hexA(colors.d2, 0.3), hexA(colors.d2, 0)],
				};
				const chartHeight = (): number =>
					fillHeight && container.clientHeight > 0 ? container.clientHeight : height;

				// Per-variant path builders: bars → grouped bars, smooth → splines, area/line → default linear.
				const bars = UPlot.paths?.bars?.({ size: [0.68, 60] });
				const spline = UPlot.paths?.spline?.();
				const filled = variant === 'area' || variant === 'smooth';
				const areaFill =
					(from: string, to: string) =>
					(u: uPlot): CanvasGradient =>
						fill(u.ctx, from, to, u.bbox.top + u.bbox.height);

				const seriesCfg: uPlot.Series[] = [
					{
						// The legend's x readout: the reader's clock, and named, so a bucket can be
						// matched against a server log without guessing which timezone it is in.
						value: (_u, v) => (v == null ? '—' : formatStamp(v * 1000)),
					},
					{
						label: 'Pageviews',
						stroke: P.ink,
						width: variant === 'bars' ? 0 : 2.25,
						fill:
							variant === 'bars'
								? areaFill(hexA(pvColor, 0.6), hexA(pvColor, 0.2))
								: filled
									? areaFill(P.pvFill[0], P.pvFill[1])
									: undefined,
						paths:
							variant === 'bars' ? bars : variant === 'smooth' ? spline : undefined,
						points: { show: false },
						value: (_u, v) => (v == null ? '—' : formatNumber(v)),
					},
					{
						label: 'Visitors',
						stroke: P.accent,
						width: 2.25,
						fill: filled ? areaFill(P.visFill[0], P.visFill[1]) : undefined,
						paths: variant === 'smooth' ? spline : undefined,
						points: { show: false },
						value: (_u, v) => (v == null ? '—' : formatNumber(v)),
					},
				];
				if (trend) {
					// A dashed trailing-average overlay of pageviews, so the trend reads through day-to-day noise.
					seriesCfg.push({
						label: 'Trend',
						stroke: 'rgba(255,255,255,0.5)',
						width: 1.5,
						dash: [5, 4],
						points: { show: false },
						value: (_u, v) => (v == null ? '—' : formatNumber(v)),
					});
				}

				const opts: uPlot.Options = {
					width: container.clientWidth || 640,
					height: chartHeight(),
					padding: [12, 8, 0, 8],
					// The x-axis TICKS were the quietest instance of the two-clocks bug: uPlot's time
					// axis renders in the browser's timezone by default, so the ticks were local while
					// the readout above them said UTC. Both now follow the reader's chosen clock.
					...(clock === 'utc'
						? { tzDate: (ts: number) => UPlot.tzDate(new Date(ts * 1000), 'Etc/UTC') }
						: {}),
					plugins: [
						annotationPlugin(() => annotationsRef.current, {
							anomaly: P.anomalyMark,
							note: P.noteMark,
						}),
						...(fillHeight ? [tooltipPlugin(() => tooltipRef.current)] : []),
					],
					cursor: {
						y: false,
						// A bold hover marker: a filled ring at the hovered value on each series.
						points: { size: 9, width: 2 },
						// Drag-to-zoom the time axis only in the expanded hero (compact click expands the tile);
						// uPlot's built-in double-click resets the zoom.
						drag: zoomable
							? { x: true, y: false }
							: { x: false, y: false, setScale: false },
					},
					legend: { show: !fillHeight, live: true },
					series: seriesCfg,
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
					// Log scale clamps to positive values (uPlot handles zero buckets by flooring them).
					scales: {
						x: { time: true },
						y: { distr: scale === 'log' ? 3 : 1 },
					},
				};

				try {
					chart = new UPlot(opts, dataRef.current, container);
				} catch {
					return;
				}
				chartRef.current = chart;

				observer = new ResizeObserver((entries) => {
					const entry = entries[0];
					if (entry && chart)
						chart.setSize({
							width: entry.contentRect.width,
							height: chartHeight(),
						});
				});
				observer.observe(container);
			})
			.catch(() => {
				// The chunk could not be fetched. The container stays empty rather than throwing, and the
				// surrounding Card / tile chrome (title, legend, empty + error states) still renders.
			});

		return () => {
			disposed = true;
			observer?.disconnect();
			chart?.destroy();
			chartRef.current = null;
		};
		// `data` is intentionally omitted: the chart is built once (from dataRef) and data *changes* tween
		// via the effect above, rather than rebuilding the canvas on every filter/range change.
	}, [
		height,
		fillHeight,
		colors.d1,
		colors.d2,
		colors.d3,
		colors.grid,
		colors.faint,
		variant,
		scale,
		trend,
		accent,
		zoomable,
		clock,
	]);

	return (
		<div
			ref={containerRef}
			className={
				fillHeight
					? 'uplot-container chart-hero relative h-full w-full'
					: 'uplot-container w-full'
			}
			// uPlot now arrives a tick after mount, so the box it will occupy is reserved up front and
			// nothing below the chart jumps when it lands. `fillHeight` is already sized by its parent.
			style={fillHeight ? undefined : { minHeight: height }}
		>
			{fillHeight ? (
				<div
					ref={tooltipRef}
					className="pointer-events-none absolute top-0 left-0 z-20 rounded-lg border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] px-2.5 py-2 opacity-0 shadow-float ring-1 ring-[color:rgb(var(--border))] backdrop-blur transition-opacity duration-100"
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
	variant = 'area',
	scale = 'linear',
	trend = false,
	accent,
	zoomable = false,
}: TrafficChartProps): ReactElement {
	const colors = useThemeColors();
	const anomalyCount = annotations.filter((annotation) => annotation.kind === 'anomaly').length;
	const noteCount = annotations.length - anomalyCount;
	const accessibleAnnotations =
		annotations.length > 0 ? (
			<ul className="sr-only" aria-label="Traffic chart annotations">
				{annotations.map((annotation, index) => (
					<li key={`${annotation.kind}-${annotation.t}-${index}`}>
						{annotation.kind === 'note' ? 'Operator note' : 'Detected anomaly'}:{' '}
						{formatStamp(annotation.t)} — {annotation.label}
					</li>
				))}
			</ul>
		) : null;
	// The header states the clock, so it has to re-render when the clock changes.
	useClockMode();
	if (bare) {
		return (
			<>
				{series.length === 0 ? (
					// "No data yet" said nothing a reader did not already know. An empty series here is a
					// statement about the SELECTED RANGE, and naming that is what tells someone whether to
					// widen the range or go looking for a broken snippet.
					<div className="flex h-full items-center justify-center px-4 text-center text-[color:var(--faint)] text-sm">
						No traffic recorded in the selected range
					</div>
				) : (
					<ChartCanvas
						series={series}
						height={height}
						annotations={annotations}
						colors={colors}
						fillHeight
						variant={variant}
						scale={scale}
						trend={trend}
						accent={accent}
						zoomable={zoomable}
					/>
				)}
				{accessibleAnnotations}
			</>
		);
	}
	return (
		<Card>
			<div className="mb-4 flex items-center justify-between">
				<h3 className="text-[13px] font-semibold uppercase tracking-wide text-[color:var(--muted)]">
					{title}
				</h3>
				<div className="flex items-center gap-3 text-xs text-[color:var(--faint)]">
					{noteCount > 0 ? (
						<span className="inline-flex items-center gap-1">
							<span className="inline-block h-2 w-2 rounded-full bg-[color:var(--d2)]" />
							{noteCount} {noteCount === 1 ? 'note' : 'notes'}
						</span>
					) : null}
					{anomalyCount > 0 ? (
						<span className="inline-flex items-center gap-1">
							<span className="inline-block h-2 w-2 rounded-full bg-[color:var(--neg)]" />
							{anomalyCount} {anomalyCount === 1 ? 'anomaly' : 'anomalies'}
						</span>
					) : null}
					<span title={`All times on this chart are ${clockZone()}`}>{clockLabel()}</span>
				</div>
			</div>
			{accessibleAnnotations}
			{loading ? (
				<div
					className="w-full animate-pulse rounded-xl bg-[color:rgb(var(--hover))]"
					style={{ height }}
					aria-hidden="true"
				/>
			) : error ? (
				<div
					className="flex items-center justify-center text-sm text-neg"
					style={{ height }}
					role="alert"
				>
					{error}
				</div>
			) : series.length === 0 ? (
				<div
					className="flex flex-col items-center justify-center gap-1 px-4 text-center text-[color:var(--faint)] text-sm"
					style={{ height }}
				>
					<span>No traffic recorded in the selected range</span>
					<span className="text-xs">
						Widen the date range, or drop the segment filter if one is applied.
					</span>
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
