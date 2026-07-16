// Time-series chart: thin React wrapper around uPlot. Feeds pageviews + visitors as two
// series (x = bucket seconds), resizes with a ResizeObserver, and tears down on unmount.
// uPlot needs canvas; if the mount throws (e.g. under jsdom) we fall back to an empty state.

import type { SeriesPoint } from '@countless/shared';
import { type ReactElement, useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

interface TrafficChartProps {
	series: SeriesPoint[];
	loading?: boolean;
	error?: string | null;
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

function ChartCanvas({ series }: { series: SeriesPoint[] }): ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const opts: uPlot.Options = {
			width: container.clientWidth || 600,
			height: 280,
			cursor: { y: false },
			legend: { show: true },
			series: [
				{},
				{
					label: 'Pageviews',
					stroke: '#171717',
					width: 2,
					fill: 'rgba(23,23,23,0.06)',
				},
				{
					label: 'Visitors',
					stroke: '#0ea5e9',
					width: 2,
					fill: 'rgba(14,165,233,0.06)',
				},
			],
			axes: [
				{ stroke: '#a3a3a3', grid: { stroke: '#f5f5f5' } },
				{ stroke: '#a3a3a3', grid: { stroke: '#f5f5f5' } },
			],
			scales: { x: { time: true } },
		};

		let chart: uPlot | null = null;
		try {
			chart = new uPlot(opts, buildData(series), container);
		} catch {
			// jsdom / no-canvas environments: skip live rendering, wrapper still mounts.
			return;
		}

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry && chart) chart.setSize({ width: entry.contentRect.width, height: 280 });
		});
		observer.observe(container);

		return () => {
			observer.disconnect();
			chart?.destroy();
		};
	}, [series]);

	return <div ref={containerRef} className="uplot-container w-full" />;
}

export function TrafficChart({ series, loading, error }: TrafficChartProps): ReactElement {
	return (
		<section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
			<h2 className="mb-4 text-sm font-medium text-neutral-500">Traffic over time</h2>
			{loading ? (
				<div className="h-[280px] w-full animate-pulse rounded-lg bg-neutral-100" />
			) : error ? (
				<div className="flex h-[280px] items-center justify-center text-sm text-red-600">
					{error}
				</div>
			) : series.length === 0 ? (
				<div className="flex h-[280px] items-center justify-center text-sm text-neutral-400">
					No data yet
				</div>
			) : (
				<ChartCanvas series={series} />
			)}
		</section>
	);
}
