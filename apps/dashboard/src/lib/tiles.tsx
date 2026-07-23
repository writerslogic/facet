// The tile catalog. Every Overview tile is one entry here — a pure `render(ctx)` over a shared
// TileContext that the board computes once per fetch. This single registry powers the whole bento:
// adding a tile type = one entry; "replace" swaps a slot's tileId; "rearrange" reorders slots; and
// drill-down reuses the same render with `expanded` so a tile can show more when it fills the overlay.

import type {
	CountRow,
	CubeCell,
	EngagementSummary,
	SeriesPoint,
	StatsResponse,
} from '@facet/shared';
import type { ReactNode } from 'react';
import { KpiTile, type TileEmphasis } from '../components/BentoTile.js';
import { FlowTile } from '../components/FlowTile.js';
import { TopList } from '../components/TopList.js';
import type { ChartAnnotation } from '../components/TrafficChart.js';
import { TrafficChart } from '../components/TrafficChart.js';
import type { CubeAxis, CubeFilter, ServerFilter } from './cube.js';
import { formatDuration, formatPercent } from './format.js';

/** Everything a tile might render, computed once by the board and shared by every tile + the overlay. */
export interface TileContext {
	summary: { pageviews: number; visitors: number; events: number };
	series: SeriesPoint[];
	annotations: ChartAnnotation[];
	deltas: { pv: number | null; vis: number | null; ev: number | null };
	sparks: { pv: number[]; vis: number[]; ev: number[] };
	sense: (d: number | null) => 'improvement' | 'regression' | 'neutral';
	flowCells: CubeCell[];
	data: StatsResponse;
	engagement: EngagementSummary;
	anyFilter: boolean;
	cubeFilter: CubeFilter;
	serverFilter: ServerFilter;
	toggleServer: (key: keyof ServerFilter) => (value: string) => void;
	dimRows: (axis: CubeAxis, fallback: CountRow[]) => CountRow[];
	dimSelect: (axis: CubeAxis) => ((key: string) => void) | undefined;
}

/** A tile definition. `render` receives the shared context and whether it is drawing inside the
 * drill-down overlay (so lists can show more rows, the chart can breathe, etc.). */
export interface TileDef {
	id: string;
	title: string;
	/** Default board size key (see SIZES). */
	size: SizeKey;
	render: (ctx: TileContext, expanded?: boolean) => ReactNode;
	/** Optional header control (e.g. the anomaly legend on the traffic chart). */
	action?: (ctx: TileContext) => ReactNode;
	/** KPI tiles gain nothing from an overlay; skip the expand affordance for them. */
	expandable?: boolean;
	/** The body renders its own title (KPI tiles), so the surrounding tile omits its header. */
	selfLabeled?: boolean;
	/** Surface emphasis — draws the eye to the hero chart/flow and the KPI band. */
	emphasis?: TileEmphasis;
}

/** Named grid spans so a slot persists a compact size token rather than raw Tailwind. `kpi` is a short
 * wide band for metric readouts; `sm`/`md` are taller compact tiles; `lg`/`short`/`wide`/`tall`/`xl`
 * suit charts, flows, and lists. The default layout packs exactly into the 6×6 grid with no holes. */
export type SizeKey = 'kpi' | 'sm' | 'md' | 'lg' | 'wide' | 'tall' | 'xl' | 'short';
export const SIZES: Record<SizeKey, string> = {
	kpi: 'col-span-1 lg:col-span-2 lg:row-span-1',
	sm: 'col-span-1 lg:col-span-1 lg:row-span-2',
	md: 'col-span-1 lg:col-span-2 lg:row-span-2',
	lg: 'col-span-2 lg:col-span-3 lg:row-span-2',
	short: 'col-span-2 lg:col-span-3 lg:row-span-1',
	tall: 'col-span-2 lg:col-span-3 lg:row-span-3',
	wide: 'col-span-2 lg:col-span-6 lg:row-span-2',
	xl: 'col-span-2 row-span-2 lg:col-span-4 lg:row-span-3',
};

/** Human labels for the resize control (never surface the raw token). */
export const SIZE_LABEL: Record<SizeKey, string> = {
	kpi: 'Metric',
	sm: 'Small',
	md: 'Medium',
	lg: 'Large',
	short: 'Short',
	wide: 'Wide',
	tall: 'Tall',
	xl: 'Hero',
};

/** Resize cycles are kind-aware so a tile only steps through sizes that suit it — and every shipped
 * default size stays reachable (KPIs keep their short band; charts keep short/wide/tall). */
export const KPI_CYCLE: SizeKey[] = ['kpi', 'sm', 'md', 'lg'];
export const CHART_CYCLE: SizeKey[] = ['md', 'lg', 'short', 'wide', 'tall', 'xl'];

function ListBody({
	title,
	rows,
	onSelect,
	activeKey,
	expanded,
}: {
	title: string;
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	expanded?: boolean;
}): ReactNode {
	return (
		<TopList
			bare
			limit={expanded ? 25 : 6}
			title={title}
			rows={rows}
			onSelect={onSelect}
			activeKey={activeKey}
		/>
	);
}

/** A tiny stat row for the engagement tile. */
function Stat({ label, value }: { label: string; value: string }): ReactNode {
	return (
		<div className="flex items-baseline justify-between gap-2 border-neutral-100 border-b py-2 last:border-0">
			<span className="text-neutral-500 text-xs">{label}</span>
			<span className="tabular font-semibold text-neutral-900 text-sm">{value}</span>
		</div>
	);
}

/** The catalog, keyed by tile id. Order here is the "Add tile" menu order. */
export const TILE_REGISTRY: Record<string, TileDef> = {
	traffic: {
		id: 'traffic',
		title: 'Traffic over time',
		size: 'xl',
		emphasis: 'hero',
		expandable: true,
		action: (ctx) =>
			ctx.annotations.length > 0 ? (
				<span className="inline-flex items-center gap-1 text-[11px] text-neutral-400">
					<span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500" />
					Anomaly
				</span>
			) : null,
		render: (ctx) => (
			<TrafficChart
				bare
				series={ctx.series}
				annotations={ctx.annotations}
				loading={false}
				error={null}
			/>
		),
	},
	pageviews: {
		id: 'pageviews',
		title: 'Pageviews',
		size: 'kpi',
		selfLabeled: true,
		emphasis: 'kpi',
		render: (ctx) => (
			<KpiTile
				label="Pageviews"
				value={ctx.summary.pageviews}
				deltaPct={ctx.deltas.pv}
				deltaSense={ctx.sense(ctx.deltas.pv)}
				spark={ctx.sparks.pv}
				stroke="#0f172a"
			/>
		),
	},
	visitors: {
		id: 'visitors',
		title: 'Visitors',
		size: 'kpi',
		selfLabeled: true,
		emphasis: 'kpi',
		render: (ctx) => (
			<KpiTile
				label="Visitors"
				value={ctx.summary.visitors}
				deltaPct={ctx.deltas.vis}
				deltaSense={ctx.sense(ctx.deltas.vis)}
				spark={ctx.sparks.vis}
				stroke="#6366f1"
			/>
		),
	},
	events: {
		id: 'events',
		title: 'Events',
		size: 'kpi',
		selfLabeled: true,
		emphasis: 'kpi',
		render: (ctx) => (
			<KpiTile
				label="Events"
				value={ctx.summary.events}
				deltaPct={ctx.deltas.ev}
				deltaSense={ctx.sense(ctx.deltas.ev)}
				spark={ctx.sparks.ev}
				stroke="#8b5cf6"
			/>
		),
	},
	flow: {
		id: 'flow',
		title: 'Traffic flow',
		size: 'tall',
		emphasis: 'hero',
		expandable: true,
		render: (ctx) => <FlowTile cells={ctx.flowCells} />,
	},
	pages: {
		id: 'pages',
		title: 'Top pages',
		size: 'lg',
		expandable: true,
		render: (ctx, expanded) =>
			ListBody({
				title: 'Top pages',
				rows: ctx.data.top_paths,
				onSelect: ctx.toggleServer('path'),
				activeKey: ctx.serverFilter.path,
				expanded,
			}),
	},
	referrers: {
		id: 'referrers',
		title: 'Referrers',
		size: 'lg',
		expandable: true,
		render: (ctx, expanded) =>
			ListBody({
				title: 'Referrers',
				rows: ctx.data.top_referrers,
				onSelect: ctx.toggleServer('referrer'),
				activeKey: ctx.serverFilter.referrer,
				expanded,
			}),
	},
	countries: {
		id: 'countries',
		title: 'Countries',
		size: 'short',
		expandable: true,
		render: (ctx, expanded) =>
			ListBody({
				title: 'Countries',
				rows: ctx.dimRows('country', ctx.data.top_countries),
				onSelect: ctx.dimSelect('country'),
				activeKey: ctx.cubeFilter.country,
				expanded,
			}),
	},
	devices: {
		id: 'devices',
		title: 'Devices',
		size: 'short',
		expandable: true,
		render: (ctx, expanded) =>
			ListBody({
				title: 'Devices',
				rows: ctx.dimRows('device', ctx.data.top_devices),
				onSelect: ctx.dimSelect('device'),
				activeKey: ctx.cubeFilter.device,
				expanded,
			}),
	},
	channels: {
		id: 'channels',
		title: 'Channels',
		size: 'lg',
		expandable: true,
		render: (ctx, expanded) =>
			ListBody({
				title: 'Channels',
				rows: ctx.dimRows('channel', ctx.data.channels),
				onSelect: ctx.dimSelect('channel'),
				activeKey: ctx.cubeFilter.channel,
				expanded,
			}),
	},
	events_list: {
		id: 'events_list',
		title: 'Top events',
		size: 'lg',
		expandable: true,
		render: (ctx, expanded) =>
			ListBody({
				title: 'Top events',
				rows: ctx.data.top_events,
				expanded,
			}),
	},
	engagement: {
		id: 'engagement',
		title: 'Engagement',
		size: 'md',
		render: (ctx) => {
			const e = ctx.engagement;
			return (
				<div className="flex h-full flex-col justify-center">
					<Stat label="Sessions" value={e.sessions.toLocaleString()} />
					<Stat label="Bounce rate" value={formatPercent(e.bounce_rate)} />
					<Stat label="Avg. duration" value={formatDuration(e.avg_duration_ms)} />
				</div>
			);
		},
	},
};

/** A placed tile: a stable identity (`uid`, so reorder preserves per-tile state and never remounts the
 * chart), which tile it shows, and its grid size. */
export interface Slot {
	uid: string;
	tileId: string;
	size: SizeKey;
}

/** A fresh unique slot id. Prefixed with the tile id purely to stay debuggable. */
export function newSlotUid(tileId: string): string {
	const rand = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
	return `${tileId}-${rand}`;
}

/** The out-of-the-box board — reproduces the shipped layout. Users mutate a copy in localStorage.
 * Default uids are the tile ids (each tile appears once), which keeps them stable across reloads. */
export const DEFAULT_LAYOUT: Slot[] = [
	{ uid: 'traffic', tileId: 'traffic', size: 'xl' },
	{ uid: 'pageviews', tileId: 'pageviews', size: 'kpi' },
	{ uid: 'visitors', tileId: 'visitors', size: 'kpi' },
	{ uid: 'events', tileId: 'events', size: 'kpi' },
	{ uid: 'flow', tileId: 'flow', size: 'tall' },
	{ uid: 'pages', tileId: 'pages', size: 'lg' },
	{ uid: 'countries', tileId: 'countries', size: 'short' },
];
