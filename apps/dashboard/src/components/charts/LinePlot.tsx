// The canvas both temporal charts draw on.
//
// WHY uPLOT AND NOT SVG: the worst case here is 8 lines × 2160 hourly buckets = 17k points, and the
// brush drags them. As SVG that is eight <path> elements whose `d` has to be rebuilt every frame —
// ~17k number formats plus a full path re-parse per frame — and the browser re-rasterizes the whole
// layer each time. uPlot draws the same data to a canvas in about a millisecond, caches its Path2D
// objects so an alpha-only change costs a re-stroke rather than a re-tessellation, and recomputes
// the y-domain from the visible x-window for free (which is exactly what a zoom needs).
//
// It also costs nothing: uPlot is ALREADY the dashboard's chart renderer (the hero TrafficChart) and
// is already behind a dynamic import, so the same lazily-fetched chunk serves these charts too —
// the 393 kB initial bundle is untouched, and the board keeps ONE visual language (same grid, same
// axis font, same tick spacing) instead of gaining a hand-rolled SVG dialect beside it.
//
// What is NOT uPlot's: hover, tooltips, focus/dim and the brush. Those come from the shared
// interaction layer (lib/chartInteraction) and <ChartTooltip>, so these charts behave like every
// other chart on the board rather than like uPlot's demos.

import { type ReactElement, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useSpring } from '../../lib/chartInteraction.js';
import { formatStamp } from '../../lib/datetime.js';
import { formatCompact } from '../../lib/format.js';
import { useThemeColors } from '../../theme.js';

type UPlotCtor = typeof import('uplot');

// One in-flight request shared by every plot on the page. Mirrors TrafficChart's loader; the module
// registry dedupes the import itself, so a board with both charts fetches the chunk once.
let uplotPending: Promise<UPlotCtor> | null = null;

function loadUPlot(): Promise<UPlotCtor> {
	uplotPending ??= import('uplot').then((m) => m.default);
	return uplotPending;
}

/** A faint area fill under a stroke. Only a 6-digit hex gets one: the palette tokens all resolve to
 * that form, and appending an alpha pair to anything else would produce an invalid canvas colour. */
function hexFill(color: string | undefined): string | undefined {
	return color && /^#[0-9a-f]{6}$/i.test(color) ? `${color}26` : undefined;
}

/** The imperative surface a chart needs from its canvas: where things are, and where to look. */
export interface PlotHandle {
	/** Closest bucket index to a pixel x measured from the PLOT AREA's left edge, or null. */
	posToIdx: (localX: number) => number | null;
	/** Pixel x of a bucket index, measured from the plot area's left edge. */
	idxToPos: (index: number) => number | null;
	/** The plot area's box inside the chart container, in CSS pixels. */
	area: () => { left: number; top: number; width: number; height: number } | null;
}

export interface LinePlotProps {
	/** Bucket starts in SECONDS (uPlot's time scale unit), ascending. */
	x: number[];
	/** One row per line, aligned to `x`; null is a gap, never a zero. */
	ys: (number | null)[][];
	/** Concrete stroke colours (canvas cannot read `var(--c1)`), one per line. */
	colors: string[];
	/** Per-line dash pattern — the redundant, non-colour encoding. */
	dashes: (number[] | undefined)[];
	labels: string[];
	/** Per-line target opacity (from `useSeriesFocus().opacityFor`). Springs to its target. */
	alphas?: number[];
	/** Explicit x-scale window in seconds. Omitted = auto (whole range). */
	xMin?: number;
	xMax?: number;
	/** Draw axes + grid. The minimap turns them off — it is a timeline, not a chart to read values off. */
	axes?: boolean;
	/** Fill the first line under its stroke. Used by the minimap's single aggregate line. */
	area?: boolean;
	strokeWidth?: number;
	/** Bucket index to mark with a vertical crosshair, or null. */
	crosshair?: number | null;
	className?: string;
	plotRef?: RefObject<PlotHandle | null>;
	/** Fired once the canvas exists (or after it failed to build), so overlays can position. */
	onReady?: () => void;
}

/**
 * One line's opacity, sprung to its target so focus reads as a cross-fade rather than a switch.
 *
 * A component per line rather than N `useSpring` calls in the parent: the hook count then stays
 * constant per component, and each spring re-renders only its own (null-rendering) instance instead
 * of the whole chart 60 times a second.
 */
function SeriesAlpha({
	index,
	target,
	apply,
}: {
	index: number;
	target: number;
	apply: (index: number, alpha: number) => void;
}): null {
	const alpha = useSpring(target, { stiffness: 210, damping: 30 });
	useEffect(() => {
		apply(index, alpha);
	}, [index, alpha, apply]);
	return null;
}

export function LinePlot({
	x,
	ys,
	colors,
	dashes,
	labels,
	alphas,
	xMin,
	xMax,
	axes = true,
	area = false,
	strokeWidth = 2,
	crosshair = null,
	className,
	plotRef,
	onReady,
}: LinePlotProps): ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const crosshairRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<uPlot | null>(null);
	// Canvas cannot read `var(--faint)`; the axis/grid hues have to arrive already resolved, and a
	// palette switch has to rebuild the instance to pick up the new ones (see `structureKey`).
	const theme = useThemeColors();
	const [ready, setReady] = useState(false);
	const onReadyRef = useRef(onReady);
	onReadyRef.current = onReady;

	const data = useMemo(() => [x, ...ys] as uPlot.AlignedData, [x, ys]);
	const dataRef = useRef(data);
	dataRef.current = data;

	// A redraw is coalesced to one per frame: eight springs settling at once would otherwise ask for
	// eight redraws in the same frame, and `redraw(false)` re-strokes the cached paths, so the cost
	// is real but only worth paying once.
	const redrawPending = useRef(false);
	const applyAlpha = useMemo(
		() =>
			(index: number, alpha: number): void => {
				const chart = chartRef.current;
				const series = chart?.series[index + 1];
				if (!chart || !series) return;
				series.alpha = alpha;
				if (redrawPending.current) return;
				redrawPending.current = true;
				requestAnimationFrame(() => {
					redrawPending.current = false;
					if (typeof chartRef.current?.redraw === 'function')
						chartRef.current.redraw(false);
				});
			},
		[],
	);

	// Structure (line count, colours, axes, palette) rebuilds the canvas; data and scales do not.
	const structureKey = `${ys.length}|${colors.join(',')}|${axes}|${area}|${strokeWidth}|${theme.faint}|${theme.grid}`;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `structureKey` is the digest of every option baked into the instance; data/labels/dashes are read through refs or are covered by it
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let disposed = false;
		let chart: uPlot | null = null;
		let observer: ResizeObserver | null = null;

		void loadUPlot()
			.then((UPlot) => {
				if (disposed) return;
				const height = (): number => container.clientHeight || 160;
				const seriesCfg: uPlot.Series[] = [
					{ value: (_u, v) => (v == null ? '—' : formatStamp(v * 1000)) },
					...ys.map((_row, i) => ({
						label: labels[i] ?? `Series ${i + 1}`,
						stroke: colors[i] ?? '#888',
						width: strokeWidth,
						dash: dashes[i],
						alpha: alphas?.[i] ?? 1,
						points: { show: false },
						// The minimap's one aggregate line reads as a filled timeline; the primary
						// chart's lines never fill — eight overlapping fills is mud.
						fill: area && i === 0 ? hexFill(colors[i]) : undefined,
					})),
				];
				const opts: uPlot.Options = {
					width: container.clientWidth || 480,
					height: height(),
					padding: axes ? [10, 8, 0, 0] : [2, 0, 2, 0],
					// The dashboard's own hover/crosshair comes from `useHoverTarget`; uPlot's would
					// be a second, differently-behaving cursor on the same pixel.
					cursor: { show: false, drag: { x: false, y: false, setScale: false } },
					legend: { show: false },
					series: seriesCfg,
					axes: axes
						? [
								{
									stroke: theme.faint,
									grid: { show: false },
									ticks: { stroke: theme.grid, size: 4 },
									font: '11px Inter, sans-serif',
									space: 64,
								},
								{
									stroke: theme.faint,
									grid: { stroke: theme.grid, width: 1 },
									ticks: { show: false },
									font: '11px Inter, sans-serif',
									size: 40,
									values: (_u, splits) => splits.map((v) => formatCompact(v)),
								},
							]
						: [
								{ show: false, grid: { show: false }, ticks: { show: false } },
								{ show: false, grid: { show: false }, ticks: { show: false } },
							],
					scales: { x: { time: true }, y: { distr: 1 } },
				};
				try {
					chart = new UPlot(opts, dataRef.current, container);
				} catch {
					// jsdom (no canvas) and any future headless render land here. The container stays
					// empty; the chart's chrome — legend, readout, sr-only table — still renders.
					setReady(true);
					onReadyRef.current?.();
					return;
				}
				chartRef.current = chart;
				observer = new ResizeObserver((entries) => {
					const entry = entries[0];
					if (entry && chart)
						chart.setSize({ width: entry.contentRect.width, height: height() });
				});
				observer.observe(container);
				setReady(true);
				onReadyRef.current?.();
			})
			.catch(() => {
				setReady(true);
				onReadyRef.current?.();
			});

		return () => {
			disposed = true;
			observer?.disconnect();
			chart?.destroy();
			chartRef.current = null;
			setReady(false);
		};
	}, [structureKey]);

	// Whether the caller owns the x-scale, read through a ref so a moving window does NOT put itself
	// in the data effect's dependencies — `setData` is a full re-ingest plus redraw, and running it
	// on every frame of a zoom was measurably the most expensive thing the drag did.
	const controlled = useRef(xMin != null);
	controlled.current = xMin != null;

	// Data swaps keep the current x-window (`resetScales: false`); the window effect below owns the
	// scale. Resetting here would yank a zoomed reader back to the full range on every refetch.
	useEffect(() => {
		const chart = chartRef.current;
		if (chart && typeof chart.setData === 'function') chart.setData(data, !controlled.current);
	}, [data]);

	// The zoom itself. The two edges are separate springs that tick in separate frame callbacks, so
	// the scale is applied on a coalesced frame: without it every frame of a drag redrew the chart
	// twice, once per edge, for a single visible result.
	//
	// `ready` is a dependency because a rebuilt instance (a palette switch changes every stroke, so
	// the canvas is rebuilt) starts on the auto scale: without re-applying, switching palettes while
	// zoomed silently threw the reader back to the whole range.
	const windowRef = useRef<[number, number] | null>(null);
	const scalePending = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `ready` re-applies the window to a freshly built instance
	useEffect(() => {
		if (xMin == null || xMax == null || !(xMax > xMin)) return;
		windowRef.current = [xMin, xMax];
		if (scalePending.current) return;
		scalePending.current = true;
		requestAnimationFrame(() => {
			scalePending.current = false;
			const chart = chartRef.current;
			const next = windowRef.current;
			if (!chart || !next || typeof chart.setScale !== 'function') return;
			chart.setScale('x', { min: next[0], max: next[1] });
		});
	}, [xMin, xMax, ready]);

	// Expose the geometry overlays need. Rebuilt when the plot appears so a consumer's effects rerun.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `ready` is the signal that chartRef now holds an instance
	useEffect(() => {
		if (!plotRef) return;
		const handle: PlotHandle = {
			posToIdx: (localX) => {
				const chart = chartRef.current;
				if (!chart || typeof chart.posToIdx !== 'function') return null;
				const index = chart.posToIdx(localX);
				return Number.isFinite(index) ? index : null;
			},
			idxToPos: (index) => {
				const chart = chartRef.current;
				const value = chart?.data[0]?.[index];
				if (!chart || value == null || typeof chart.valToPos !== 'function') return null;
				return chart.valToPos(value, 'x');
			},
			area: () => {
				const over = chartRef.current?.over;
				if (!over) return null;
				return {
					left: over.offsetLeft,
					top: over.offsetTop,
					width: over.clientWidth,
					height: over.clientHeight,
				};
			},
		};
		plotRef.current = handle;
		return () => {
			plotRef.current = null;
		};
	}, [plotRef, ready]);

	// The crosshair is positioned imperatively: it moves on every pointer frame, and re-rendering the
	// chart subtree to move one 1px rule would be the most expensive way to draw a line.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `ready` re-runs this once the canvas exists, so a crosshair set before the chunk landed still lands
	useEffect(() => {
		const el = crosshairRef.current;
		const chart = chartRef.current;
		if (!el) return;
		const over = chart?.over;
		const value = crosshair == null ? null : chart?.data[0]?.[crosshair];
		if (!chart || !over || value == null || typeof chart.valToPos !== 'function') {
			el.style.opacity = '0';
			return;
		}
		el.style.opacity = '1';
		el.style.left = `${over.offsetLeft + chart.valToPos(value, 'x')}px`;
		el.style.top = `${over.offsetTop}px`;
		el.style.height = `${over.clientHeight}px`;
	}, [crosshair, ready]);

	return (
		<div ref={containerRef} className={className ?? 'relative h-full w-full'}>
			{alphas?.map((target, i) => (
				<SeriesAlpha
					// Lines are positional (rank order); the index IS the identity here.
					// biome-ignore lint/suspicious/noArrayIndexKey: the series' index is its identity
					key={i}
					index={i}
					target={target}
					apply={applyAlpha}
				/>
			))}
			<div
				ref={crosshairRef}
				aria-hidden="true"
				data-chrome
				data-testid="plot-crosshair"
				className="pointer-events-none absolute z-10 w-px bg-[color:var(--ink)] opacity-0"
				style={{ mixBlendMode: 'plus-lighter' }}
			/>
		</div>
	);
}
