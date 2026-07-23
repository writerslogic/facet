// Time-series chart: a thin React wrapper around uPlot. Plots pageviews + visitors as area-filled
// series with a hovering cursor, readable UTC date/number axes, and a subtle grid. Resizes with a
// ResizeObserver. uPlot needs canvas; if the mount throws (e.g. under jsdom) it degrades gracefully.

import type { SeriesPoint } from '@facet/shared';
import { type ReactElement, useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { formatCompact, formatNumber } from '../lib/format.js';
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
}

const ACCENT = '#6366f1';
const INK = '#0f172a';
const GRID = '#f1f0ee';
const AXIS = '#a3a3a3';
const MARK = '#e11d48';

/** uPlot plugin: draw a dashed vertical line + top caret at each annotation's time position. Positions
 * come from `valToPos(..., true)` (canvas pixels), matching `u.bbox`, so it aligns at any zoom/size. */
function annotationPlugin(annotations: ChartAnnotation[]): uPlot.Plugin {
	return {
		hooks: {
			draw: (u: uPlot) => {
				if (annotations.length === 0) return;
				const { ctx } = u;
				const { left, top, width, height } = u.bbox;
				ctx.save();
				for (const a of annotations) {
					const cx = Math.round(u.valToPos(a.t / 1000, 'x', true));
					if (cx < left || cx > left + width) continue;
					ctx.strokeStyle = 'rgba(225,29,72,0.45)';
					ctx.lineWidth = 1;
					ctx.setLineDash([4, 3]);
					ctx.beginPath();
					ctx.moveTo(cx, top);
					ctx.lineTo(cx, top + height);
					ctx.stroke();
					ctx.setLineDash([]);
					ctx.fillStyle = MARK;
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
	height: number,
): CanvasGradient {
	const grad = ctx.createLinearGradient(0, 0, 0, height);
	grad.addColorStop(0, from);
	grad.addColorStop(1, to);
	return grad;
}

function ChartCanvas({
	series,
	height,
	annotations,
}: {
	series: SeriesPoint[];
	height: number;
	annotations: ChartAnnotation[];
}): ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const data = useMemo(() => buildData(series), [series]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const opts: uPlot.Options = {
			width: container.clientWidth || 640,
			height,
			padding: [12, 8, 0, 8],
			plugins: [annotationPlugin(annotations)],
			cursor: {
				y: false,
				points: { size: 6 },
			},
			legend: { show: true, live: true },
			series: [
				{
					value: (_u, v) => (v == null ? '—' : new Date(v * 1000).toUTCString()),
				},
				{
					label: 'Pageviews',
					stroke: INK,
					width: 2,
					fill: (u) => fill(u.ctx, 'rgba(15,23,42,0.10)', 'rgba(15,23,42,0.00)', height),
					points: { show: false },
					value: (_u, v) => (v == null ? '—' : formatNumber(v)),
				},
				{
					label: 'Visitors',
					stroke: ACCENT,
					width: 2,
					fill: (u) =>
						fill(u.ctx, 'rgba(99,102,241,0.16)', 'rgba(99,102,241,0.00)', height),
					points: { show: false },
					value: (_u, v) => (v == null ? '—' : formatNumber(v)),
				},
			],
			axes: [
				{
					stroke: AXIS,
					grid: { show: false },
					ticks: { stroke: GRID, size: 4 },
					font: '11px Inter, sans-serif',
					space: 64,
				},
				{
					stroke: AXIS,
					grid: { stroke: GRID, width: 1 },
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
			chart = new uPlot(opts, data, container);
		} catch {
			return;
		}

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry && chart) chart.setSize({ width: entry.contentRect.width, height });
		});
		observer.observe(container);

		return () => {
			observer.disconnect();
			chart?.destroy();
		};
	}, [data, height, annotations]);

	return <div ref={containerRef} className="uplot-container w-full" />;
}

export function TrafficChart({
	series,
	loading,
	error,
	title = 'Traffic over time',
	height = 280,
	annotations = [],
}: TrafficChartProps): ReactElement {
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
				<ChartCanvas series={series} height={height} annotations={annotations} />
			)}
		</Card>
	);
}
