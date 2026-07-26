// Traffic-over-time box: the hero uPlot chart. Expanded, it reveals a headline stat strip (totals, peak
// day, daily average) over the full chart.

import type { SeriesPoint } from '@facet/shared';
import type { ReactNode } from 'react';
import { formatNumber } from '../../lib/format.js';
import {
	type ChartAnnotation,
	TrafficChart,
	type TrafficScale,
	type TrafficVariant,
} from '../TrafficChart.js';
import { ACCENT_OPTION, accentOf } from './shared.js';
import type { TileConfig, TileDef, TileOption, TileVariant } from './types.js';

/** Hero chart styles + options, chosen per-instance in Customize mode. */
const TRAFFIC_VARIANTS: TileVariant[] = [
	{ id: 'area', label: 'Area' },
	{ id: 'line', label: 'Line' },
	{ id: 'bars', label: 'Bars' },
	{ id: 'smooth', label: 'Smooth' },
];

const TRAFFIC_OPTIONS: TileOption[] = [
	{
		key: 'scale',
		label: 'Scale',
		type: 'select',
		choices: [
			{ value: 'linear', label: 'Linear' },
			{ value: 'log', label: 'Log' },
		],
		default: 'linear',
	},
	{ key: 'trend', label: 'Trend line', type: 'toggle', default: false },
	ACCENT_OPTION,
];

/** Resolve a slot's config into the chart's style props (shared by the compact + expanded charts). */
function chartStyle(config?: TileConfig): {
	variant: TrafficVariant;
	scale: TrafficScale;
	trend: boolean;
	accent: string | undefined;
} {
	return {
		variant: (config?.variant as TrafficVariant) ?? 'area',
		scale: (config?.scale as TrafficScale) ?? 'linear',
		trend: Boolean(config?.trend),
		accent: accentOf(config),
	};
}

/** One headline figure in the expanded traffic view. The diamond keys the series colour, so the strip
 * doubles as the chart legend. */
function DetailStat({
	label,
	value,
	sub,
	stroke,
}: {
	label: string;
	value: string;
	sub?: string;
	stroke?: string;
}): ReactNode {
	return (
		<div className="rounded-xl border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] px-3 py-2">
			<div className="flex items-center gap-1.5 text-[10px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em]">
				{stroke ? (
					<span
						className="inline-block size-1.5 rotate-45 rounded-[1px]"
						style={{ background: stroke }}
						aria-hidden="true"
					/>
				) : null}
				{label}
			</div>
			<div className="tabular mt-0.5 font-semibold text-2xl text-[color:var(--ink)] leading-none">
				{value}
			</div>
			{sub ? <div className="mt-0.5 text-[11px] text-[color:var(--muted)]">{sub}</div> : null}
		</div>
	);
}

function TrafficDetail({
	series,
	annotations,
	config,
}: {
	series: SeriesPoint[];
	annotations: ChartAnnotation[];
	config?: TileConfig;
}): ReactNode {
	const totalPv = series.reduce((s, p) => s + p.pageviews, 0);
	const totalVis = series.reduce((s, p) => s + p.visitors, 0);
	const peak = series.reduce(
		(best, p) => (p.pageviews > best.pageviews ? p : best),
		series[0] ?? { t: 0, pageviews: 0, visitors: 0 },
	);
	const peakDate =
		peak.t > 0
			? new Date(peak.t).toLocaleDateString('en-US', {
					month: 'short',
					day: 'numeric',
					timeZone: 'UTC',
				})
			: '—';
	const avg = series.length > 0 ? Math.round(totalPv / series.length) : 0;
	return (
		<div className="flex h-full flex-col gap-3">
			<div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
				<DetailStat label="Pageviews" value={formatNumber(totalPv)} stroke="var(--d1)" />
				<DetailStat label="Visitors" value={formatNumber(totalVis)} stroke="var(--d2)" />
				<DetailStat
					label="Peak / day"
					value={formatNumber(peak.pageviews)}
					sub={peakDate}
				/>
				<DetailStat label="Avg / day" value={formatNumber(avg)} />
			</div>
			<div className="min-h-0 flex-1">
				<TrafficChart
					bare
					series={series}
					annotations={annotations}
					loading={false}
					error={null}
					zoomable
					{...chartStyle(config)}
				/>
			</div>
		</div>
	);
}

export const trafficBox: TileDef = {
	id: 'traffic',
	title: 'Traffic over time',
	size: 'xl',
	emphasis: 'hero',
	expandable: true,
	variants: TRAFFIC_VARIANTS,
	options: TRAFFIC_OPTIONS,
	table: (ctx) => ({
		columns: ['Date', 'Pageviews', 'Visitors'],
		rows: ctx.series.map((p) => [
			new Date(p.t).toISOString().slice(0, 10),
			p.pageviews,
			p.visitors,
		]),
	}),
	action: (ctx) =>
		ctx.annotations.length > 0 ? (
			<span className="inline-flex items-center gap-1 text-[11px] text-[color:var(--muted)]">
				<span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500" />
				Anomaly
			</span>
		) : null,
	render: (ctx, expanded, config) =>
		expanded ? (
			<TrafficDetail series={ctx.series} annotations={ctx.annotations} config={config} />
		) : (
			<TrafficChart
				bare
				series={ctx.series}
				annotations={ctx.annotations}
				loading={false}
				error={null}
				{...chartStyle(config)}
			/>
		),
};
