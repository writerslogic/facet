// Brush-and-zoom: a primary trend chart over a smaller minimap timeline. Dragging a window on the
// minimap isolates it and the primary rescales to it.
//
// PERFORMANCE IS THE FEATURE. A brush that stutters is worse than no brush, so the drag path is built
// to do one thing per frame and nothing twice:
//   1. pointermove writes the raw clientX to a ref and schedules ONE rAF. Pointer events can arrive
//      faster than the display (coalesced high-rate mice, pen), and a setState per event would run
//      React several times between paints for a window that can only be drawn once.
//   2. that frame commits one window update. The brush rectangle is plain CSS left/width.
//   3. the rescale is `useSpring` on each edge, inside a leaf component that renders null — so the
//      60 Hz re-render touches two springs and one `setScale`, not the legend or the sr-only table.
//   4. uPlot re-strokes cached Path2D objects on a canvas. Nothing here rebuilds a path string.
//
// The window is held in BUCKET INDICES, not pixels or timestamps: a bucket is the smallest thing the
// data can distinguish, so the brush cannot land between two points and claim a resolution the
// series does not have. All the arithmetic is pure and lives in hooks/timeseries.ts.

import type { DimensionSeries, Interval } from '@facet/shared';
import {
	type ReactElement,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useDeferredValue,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	type BucketWindow,
	METRIC_LABEL,
	bucketTimes,
	clampWindow,
	dashOf,
	formatBucket,
	fullWindow,
	hueOf,
	indexAtX,
	isFullWindow,
	keyStep,
	moveWindow,
	resizeWindow,
	setEdge,
	summarize,
	valuesOf,
	windowLabel,
	windowToPixels,
} from '../../hooks/timeseries.js';
import { useHoverTarget, useSpring } from '../../lib/chartInteraction.js';
import { cn } from '../../lib/cn.js';
import { formatNumber } from '../../lib/format.js';
import { useSize } from '../../lib/useSize.js';
import { useThemeColors } from '../../theme.js';
import { ChartEmpty } from './ChartChrome.js';
import { ChartTooltip, TooltipRow } from './ChartTooltip.js';
import { LinePlot, type PlotHandle } from './LinePlot.js';

/** What a pointer drag on the minimap is doing. */
type DragMode =
	| { kind: 'select'; anchor: number }
	| { kind: 'move'; grab: number; span: number }
	| { kind: 'resize'; edge: 'start' | 'end' };

/**
 * The primary chart's x-window, sprung.
 *
 * Its own component, rendering nothing but the plot, because a spring re-renders its owner every
 * frame: keeping it here means a rescale re-renders one element instead of the whole chart. Two
 * springs (not one on a centre + width) so each edge retargets independently — grabbing the right
 * handle must not drag the left edge along through the animation.
 */
function ZoomedPlot({
	x,
	ys,
	colors,
	dashes,
	labels,
	window: w,
	crosshair,
	plotRef,
}: {
	x: number[];
	ys: (number | null)[][];
	colors: string[];
	dashes: (number[] | undefined)[];
	labels: string[];
	window: BucketWindow;
	crosshair: number | null;
	plotRef: RefObject<PlotHandle | null>;
}): ReactElement {
	const targetMin = x[w.from] ?? x[0] ?? 0;
	const targetMax = x[w.to] ?? x[x.length - 1] ?? 1;
	const min = useSpring(targetMin, { stiffness: 220, damping: 30 });
	const max = useSpring(targetMax, { stiffness: 220, damping: 30 });
	return (
		<LinePlot
			x={x}
			ys={ys}
			colors={colors}
			dashes={dashes}
			labels={labels}
			xMin={min}
			xMax={max}
			crosshair={crosshair}
			plotRef={plotRef}
		/>
	);
}

export interface BrushRangeProps {
	series: DimensionSeries[];
	interval: Interval;
	metric: 'pageviews' | 'events';
	dimensionLabel: string;
	truncated?: boolean;
}

export function BrushRange({
	series,
	interval,
	metric,
	dimensionLabel,
	truncated = false,
}: BrushRangeProps): ReactElement {
	const theme = useThemeColors();
	const primaryRef = useRef<HTMLDivElement>(null);
	const plotRef = useRef<PlotHandle | null>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const size = useSize(primaryRef);
	const trackSize = useSize(trackRef);
	const labelId = useId();

	const times = useMemo(() => bucketTimes(series), [series]);
	const count = times.length;
	const x = useMemo(() => times.map((t) => t / 1000), [times]);
	const ys = useMemo(
		() => series.map((s) => valuesOf(s, metric, count)),
		[series, metric, count],
	);
	const colors = useMemo(() => series.map((_s, i) => hueOf(theme.cat, i)), [series, theme.cat]);
	const dashes = useMemo(() => series.map((_s, i) => dashOf(i)), [series]);
	const labels = useMemo(() => series.map((s) => s.key), [series]);

	// The minimap plots the COMBINED series. Summing across keys is legitimate here — pageviews and
	// events are plain counts — but it is only the combined total of the keys shown, never the site's,
	// so the caption below says so rather than letting the shape imply otherwise.
	const combined = useMemo(() => {
		const out: (number | null)[] = new Array(count).fill(0);
		for (const s of series) {
			for (let i = 0; i < count; i++) {
				out[i] = (out[i] ?? 0) + (s.points[i]?.[metric] ?? 0);
			}
		}
		return [out];
	}, [series, metric, count]);

	const [w, setWindow] = useState<BucketWindow>(() => fullWindow(count));
	// A new bucket count is new data (range change, interval flip, site switch). A window carried over
	// from the previous dataset would point at times that are no longer on the axis.
	useEffect(() => {
		setWindow(fullWindow(count));
	}, [count]);

	const width = trackSize.width;
	const rect = useMemo(() => windowToPixels(w, width, count), [w, width, count]);

	// --- pointer drag ------------------------------------------------------------------------
	const dragRef = useRef<DragMode | null>(null);
	const pendingX = useRef<number | null>(null);
	const frameRef = useRef<number | null>(null);

	const commitFrame = useCallback(() => {
		frameRef.current = null;
		const track = trackRef.current;
		const mode = dragRef.current;
		const clientX = pendingX.current;
		if (!track || !mode || clientX == null) return;
		const box = track.getBoundingClientRect();
		const index = indexAtX(clientX - box.left, box.width, count);
		setWindow((current) => {
			if (mode.kind === 'select') return clampWindow({ from: mode.anchor, to: index }, count);
			// An edge drag pins the other edge; `setEdge` also stops it collapsing THROUGH it.
			if (mode.kind === 'resize') return setEdge(current, mode.edge, index, count);
			const from = index - mode.grab;
			return clampWindow({ from, to: from + mode.span }, count);
		});
	}, [count]);

	// One frame, one update: pointermove only records where the pointer is.
	const schedule = useCallback(
		(clientX: number) => {
			pendingX.current = clientX;
			if (frameRef.current != null) return;
			frameRef.current = requestAnimationFrame(commitFrame);
		},
		[commitFrame],
	);

	const endDrag = useCallback(() => {
		dragRef.current = null;
		pendingX.current = null;
		if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
		frameRef.current = null;
	}, []);

	useEffect(() => endDrag, [endDrag]);

	const startDrag = useCallback(
		(e: ReactPointerEvent, mode: DragMode) => {
			e.preventDefault();
			e.stopPropagation();
			dragRef.current = mode;
			// Capture on the track, not on the handle: the pointer routinely leaves a 10px handle
			// mid-drag, and without capture the drag would silently stop the moment it did.
			trackRef.current?.setPointerCapture(e.pointerId);
			schedule(e.clientX);
		},
		[schedule],
	);

	const onTrackPointerDown = useCallback(
		(e: ReactPointerEvent) => {
			const box = trackRef.current?.getBoundingClientRect();
			if (!box) return;
			startDrag(e, {
				kind: 'select',
				anchor: indexAtX(e.clientX - box.left, box.width, count),
			});
		},
		[startDrag, count],
	);

	const onPointerMove = useCallback(
		(e: ReactPointerEvent) => {
			if (dragRef.current) schedule(e.clientX);
		},
		[schedule],
	);

	// --- keyboard ----------------------------------------------------------------------------
	// Arrow keys on each of the three sliders: the two edges resize, the body pans. The step scales
	// with the axis (≈1% of it) so crossing 2160 hourly buckets is not 2160 key presses; Page/Home/End
	// give the coarse and absolute moves.
	const onKey = useCallback(
		(e: ReactKeyboardEvent, part: 'start' | 'end' | 'body') => {
			const step = keyStep(count, e.shiftKey);
			const apply = (delta: number): void => {
				e.preventDefault();
				setWindow((current) =>
					part === 'body'
						? moveWindow(current, delta, count)
						: resizeWindow(current, part, delta, count),
				);
			};
			switch (e.key) {
				case 'ArrowLeft':
				case 'ArrowDown':
					apply(-step);
					break;
				case 'ArrowRight':
				case 'ArrowUp':
					apply(step);
					break;
				case 'PageDown':
					apply(-keyStep(count, true));
					break;
				case 'PageUp':
					apply(keyStep(count, true));
					break;
				case 'Home':
					e.preventDefault();
					setWindow((current) =>
						part === 'body'
							? moveWindow(current, -count, count)
							: setEdge(current, part, 0, count),
					);
					break;
				case 'End':
					e.preventDefault();
					setWindow((current) =>
						part === 'body'
							? moveWindow(current, count, count)
							: setEdge(current, part, count - 1, count),
					);
					break;
				case 'Escape':
					e.preventDefault();
					setWindow(fullWindow(count));
					break;
				default:
			}
		},
		[count],
	);

	// --- crosshair ---------------------------------------------------------------------------
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
	const { hover, handlers } = useHoverTarget(primaryRef, resolve);
	const hoverIndex = hover?.datum ?? null;
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

	// Summarising the window walks every point in it — 17k of them at the worst case — and nothing on
	// screen changes while a drag is in flight except the chart and the brush rect. The table follows
	// the SETTLED window so that walk happens once the drag pauses, not on every frame of it.
	const settled = useDeferredValue(w);
	const rows = useMemo(
		() => summarize(series, metric, settled.from, settled.to),
		[series, metric, settled],
	);
	const label = windowLabel(times, w, interval);
	const full = isFullWindow(w, count);

	if (count === 0) {
		// Same shape and wording as its sibling MultiLine: the two are one box's two chart styles, and
		// switching style must not change what the box says about having nothing to draw.
		return (
			<ChartEmpty reason="range">
				No {METRIC_LABEL[metric].toLowerCase()} were recorded for any{' '}
				{dimensionLabel.toLowerCase()} in this window.
			</ChartEmpty>
		);
	}

	const sliderClass =
		'absolute top-0 h-full w-2.5 cursor-ew-resize rounded-sm bg-[color:var(--ink)] opacity-70 transition-opacity hover:opacity-100';

	return (
		<div className="flex h-full min-h-0 flex-col gap-2">
			<div className="flex shrink-0 items-baseline gap-2 text-xs">
				{/* The window in words, updated live. Deliberately NOT an aria-live region: it changes
				    on every drag frame, and a live region would read a new sentence 60 times a second.
				    Assistive tech gets the value from the sliders' aria-valuetext instead, which is
				    announced when the value actually changes under the user's own key press. */}
				<span id={labelId} className="min-w-0 truncate text-[color:var(--muted)]">
					{full ? 'Whole range' : label}
				</span>
				<button
					type="button"
					onClick={() => setWindow(fullWindow(count))}
					disabled={full}
					className="ml-auto shrink-0 rounded-md border border-[color:rgb(var(--border))] px-2 py-0.5 text-[11px] text-[color:var(--muted)] transition-colors hover:text-[color:var(--ink)] disabled:opacity-40"
				>
					Reset zoom
				</button>
			</div>

			<div
				ref={primaryRef}
				className="relative min-h-0 flex-1"
				onPointerMove={handlers.onPointerMove}
				onPointerLeave={handlers.onPointerLeave}
			>
				<ZoomedPlot
					x={x}
					ys={ys}
					colors={colors}
					dashes={dashes}
					labels={labels}
					window={w}
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

			{/* The minimap. `touch-none` so a drag on a touchscreen brushes instead of scrolling the
			    board out from under the reader. */}
			<div
				ref={trackRef}
				data-testid="brush-track"
				className="relative h-10 shrink-0 touch-none select-none rounded-md bg-[color:rgb(var(--hover))]"
				onPointerDown={onTrackPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
			>
				<LinePlot
					x={x}
					ys={combined}
					colors={[theme.d1]}
					dashes={[undefined]}
					labels={[`Combined ${METRIC_LABEL[metric].toLowerCase()}`]}
					axes={false}
					area
					strokeWidth={1.25}
				/>
				{/* Outside the window: a scrim, so the selection reads as "this part", not "only this
				    part exists". The unselected timeline stays visible underneath. */}
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-[color:var(--bg)]/55"
					style={{ width: `${rect.left}px` }}
				/>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 right-0 rounded-r-md bg-[color:var(--bg)]/55"
					style={{ width: `${Math.max(0, width - rect.left - rect.width)}px` }}
				/>
				<div
					role="slider"
					tabIndex={0}
					aria-label={`Time window, ${dimensionLabel.toLowerCase()} trends`}
					aria-valuemin={0}
					aria-valuemax={Math.max(0, count - 1)}
					aria-valuenow={w.from}
					aria-valuetext={label}
					onKeyDown={(e) => onKey(e, 'body')}
					onPointerDown={(e) =>
						startDrag(e, {
							kind: 'move',
							grab:
								indexAtX(
									e.clientX -
										(trackRef.current?.getBoundingClientRect().left ?? 0),
									width,
									count,
								) - w.from,
							span: w.to - w.from,
						})
					}
					className={cn(
						'absolute inset-y-0 cursor-grab rounded-sm border-2 border-[color:var(--ink)]/70',
						'bg-[color:var(--ink)]/5 active:cursor-grabbing',
					)}
					style={{ left: `${rect.left}px`, width: `${rect.width}px` }}
				/>
				<div
					role="slider"
					tabIndex={0}
					aria-label="Window start"
					aria-valuemin={0}
					aria-valuemax={Math.max(0, count - 1)}
					aria-valuenow={w.from}
					aria-valuetext={
						times[w.from] === undefined
							? 'start'
							: `start ${formatBucket(times[w.from] as number, interval)} UTC`
					}
					data-testid="brush-start"
					onKeyDown={(e) => onKey(e, 'start')}
					onPointerDown={(e) => startDrag(e, { kind: 'resize', edge: 'start' })}
					className={sliderClass}
					style={{ left: `${Math.max(0, rect.left - 5)}px` }}
				/>
				<div
					role="slider"
					tabIndex={0}
					aria-label="Window end"
					aria-valuemin={0}
					aria-valuemax={Math.max(0, count - 1)}
					aria-valuenow={w.to}
					aria-valuetext={
						times[w.to] === undefined
							? 'end'
							: `end ${formatBucket(times[w.to] as number, interval)} UTC`
					}
					data-testid="brush-end"
					onKeyDown={(e) => onKey(e, 'end')}
					onPointerDown={(e) => startDrag(e, { kind: 'resize', edge: 'end' })}
					className={sliderClass}
					style={{ left: `${Math.min(width - 10, rect.left + rect.width - 5)}px` }}
				/>
			</div>

			<p className="shrink-0 text-[10px] text-[color:var(--faint)]">
				Minimap: combined {METRIC_LABEL[metric].toLowerCase()} of the {series.length} keys
				shown{truncated ? ', not of all traffic' : ''}. Drag to zoom; arrow keys move and
				resize.
			</p>

			<table className="sr-only">
				<caption>
					{METRIC_LABEL[metric]} by {dimensionLabel.toLowerCase()} over time, zoomed to{' '}
					{full ? 'the whole range' : label}. Totals below cover the selected window only.
					{truncated ? ' A longer tail of keys was not returned.' : ''}
				</caption>
				<thead>
					<tr>
						<th scope="col">{dimensionLabel}</th>
						<th scope="col">{METRIC_LABEL[metric]} in window</th>
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
