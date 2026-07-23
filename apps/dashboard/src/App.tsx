// Root dashboard component: KeyGate until at least one site profile exists, otherwise the app shell
// with the read tabs plus a self-service Settings area. Read queries are keyed by site id, and the
// react-query cache is reset when the active profile changes so one site's data never flashes under
// another site's label.

import type { CubeCell, StatsQuery } from '@facet/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Anomalies } from './components/Anomalies.js';
import { AskPanel } from './components/AskPanel.js';
import { BentoBoard, BentoSkeleton } from './components/BentoBoard.js';
import { CubeFilterBar } from './components/CubeFilterBar.js';
import { Experiments } from './components/Experiments.js';
import { ExportButton } from './components/ExportButton.js';
import { FunnelsView } from './components/FunnelsView.js';
import { KeyGate } from './components/KeyGate.js';
import { Layout } from './components/Layout.js';
import { Realtime } from './components/Realtime.js';
import { Retention } from './components/Retention.js';
import { Settings } from './components/Settings.js';
import { AuthErrorBanner, ErrorState } from './components/StatusStates.js';
import { useAnomalies } from './hooks/anomaly.js';
import { useCube } from './hooks/cube.js';
import { useCompareStats, useStats } from './hooks/stats.js';
import { cn } from './lib/cn.js';
import {
	type CubeAxis,
	type CubeFilter,
	type ServerFilter,
	cubeBreakdown,
	cubeFlow,
	cubeSeries,
	isFilterActive,
	sliceCube,
} from './lib/cube.js';
import { isAuthError } from './lib/status.js';
import type { TileContext } from './lib/tiles.js';
import { useDashboard } from './state.js';

type View = 'overview' | 'realtime' | 'funnels' | 'retention' | 'experiments' | 'anomalies' | 'ask';

// Stable empty reference so `cube.data?.cells ?? EMPTY_CELLS` keeps the same identity across renders
// (a fresh `[]` would defeat memoization of everything derived from the cube).
const EMPTY_CELLS: CubeCell[] = [];

/** True when a react-query key references the given site id, as a direct element or a nested site_id. */
function queryKeyReferencesSite(key: readonly unknown[], siteId: string): boolean {
	if (!siteId) return false;
	return key.some((part) => {
		if (part === siteId) return true;
		if (part && typeof part === 'object') {
			return (part as { site_id?: unknown }).site_id === siteId;
		}
		return false;
	});
}

const TABS: { id: View; label: string }[] = [
	{ id: 'overview', label: 'Overview' },
	{ id: 'realtime', label: 'Realtime' },
	{ id: 'funnels', label: 'Funnels' },
	{ id: 'retention', label: 'Retention' },
	{ id: 'experiments', label: 'Experiments' },
	{ id: 'anomalies', label: 'Anomalies' },
	{ id: 'ask', label: 'Ask' },
];

function Overview({
	onOpenSettings,
	filter: cubeFilter,
	onFilterChange: setCubeFilter,
	serverFilter,
	onServerFilterChange: setServerFilter,
}: {
	onOpenSettings: () => void;
	filter: CubeFilter;
	onFilterChange: (f: CubeFilter) => void;
	serverFilter: ServerFilter;
	onServerFilterChange: (f: ServerFilter) => void;
}): ReactElement {
	const { apiKey, siteId, preset, range, compare, compareRange } = useDashboard();
	const interval = preset === '24h' ? 'hour' : 'day';

	// Server-filter mode: a high-cardinality path/referrer filter is active, so the whole Overview is
	// re-fetched server-side (the cube can't slice these). Active cube dims (device/country/channel) are
	// sent along so a segment + drill-down combine. Absent path/referrer, the instant client cube runs.
	const serverMode = Boolean(serverFilter.path || serverFilter.referrer);
	// A cube slice or server drill-down is active. The period-comparison column is meaningless under a
	// filter (the compare query isn't sliced), so it's both hidden AND not fetched while filtering.
	const cubeActive = isFilterActive(cubeFilter) && !serverMode;
	const anyFilter = cubeActive || serverMode;
	const query: StatsQuery = {
		site_id: siteId,
		start: range.start,
		end: range.end,
		interval,
		...(serverMode ? { ...serverFilter, ...cubeFilter } : {}),
	};

	const { data, isLoading, error } = useStats(apiKey, query);
	const compareQuery: StatsQuery = {
		site_id: siteId,
		start: compareRange?.start ?? 0,
		end: compareRange?.end ?? 0,
		interval,
	};
	const compareStats = useCompareStats(
		apiKey,
		compareQuery,
		Boolean(compare && compareRange) && !anyFilter,
	);
	const cube = useCube(apiKey, siteId, range, interval);
	// Anomalies are layered onto the traffic chart as timeline markers (shared cache with the tab).
	const anomalies = useAnomalies(apiKey, siteId, range);

	if (error && isAuthError(error)) {
		return <AuthErrorBanner />;
	}

	if (error) {
		return (
			<ErrorState
				message="Could not load analytics"
				detail={error instanceof Error ? error.message : null}
			/>
		);
	}

	if (isLoading || !data) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<BentoSkeleton siteId={siteId} />
			</div>
		);
	}

	const summary = data.summary;
	const isEmpty = summary.pageviews === 0 && summary.visitors === 0 && summary.events === 0;
	const cmp = compare ? (compareStats.data ?? null) : null;

	// Instant client-side slicing over the in-memory cube. When a filter is active, the KPIs and chart
	// render from the sliced cube (no server round-trip); pageviews/events are exact, visitors is an
	// upper bound flagged below. Engagement is session-derived (not in the cube), so it hides under a
	// filter rather than showing unfiltered numbers next to filtered ones.
	const cubeCells = cube.data?.cells ?? EMPTY_CELLS;
	// In serverMode the fetched `data` is already fully filtered server-side, so use it directly; else
	// the cube slices client-side. `cubeActive`/`anyFilter` are computed above (they gate the compare fetch).
	const slice = cubeActive ? sliceCube(cubeCells, cubeFilter) : null;
	const displaySummary = slice
		? {
				pageviews: slice.pageviews,
				visitors: slice.visitors,
				events: slice.events,
			}
		: summary;
	const displaySeries = cubeActive ? cubeSeries(cubeCells, cubeFilter) : data.series;
	const chartAnnotations = (anomalies.data?.anomalies ?? []).map((a) => ({
		t: a.bucket,
		label: a.summary,
	}));

	// KPI deltas + sparklines for the bento tiles.
	const cmpSum = anyFilter ? null : cmp?.summary;
	const pct = (cur: number, prev?: number): number | null =>
		prev && prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
	const sense = (d: number | null): 'improvement' | 'regression' | 'neutral' =>
		d == null || d === 0 ? 'neutral' : d > 0 ? 'improvement' : 'regression';
	const sparkPv = displaySeries.map((p) => p.pageviews);
	const sparkVis = displaySeries.map((p) => p.visitors);
	// Events isn't in the server series, so its sparkline re-buckets over the cube (respecting an active
	// cube filter, matching how pv/vis reflect the current slice).
	const sparkEv = cubeCells.length
		? cubeSeries(cubeCells, cubeActive ? cubeFilter : {}).map((p) => p.events)
		: [];
	const dPv = pct(displaySummary.pageviews, cmpSum?.pageviews);
	const dVis = pct(displaySummary.visitors, cmpSum?.visitors);
	const dEv = pct(displaySummary.events, cmpSum?.events);

	// Cross-filter handlers: cube dims slice instantly; path/referrer refetch server-side.
	const hasCube = cubeCells.length > 0;
	const toggleCube = (axis: CubeAxis) => (key: string) =>
		setCubeFilter({
			...cubeFilter,
			[axis]: cubeFilter[axis] === key ? undefined : key,
		});
	const toggleServer = (key: keyof ServerFilter) => (value: string) =>
		setServerFilter({
			...serverFilter,
			[key]: serverFilter[key] === value ? undefined : value,
		});
	const dimRows = (axis: CubeAxis, fallback: typeof data.top_countries) =>
		!serverMode && hasCube ? cubeBreakdown(cubeCells, cubeFilter, axis) : fallback;
	const dimSelect = (axis: CubeAxis) => (hasCube || serverMode ? toggleCube(axis) : undefined);
	const flow = cubeFlow(cubeCells);

	const filterBar = (
		<CubeFilterBar
			cells={cubeCells}
			filter={cubeFilter}
			onChange={setCubeFilter}
			serverFilter={serverFilter}
			onServerChange={setServerFilter}
		/>
	);

	// No data yet: still render the real bento (all tiles are zero/empty-safe) so the layout never
	// collapses to a different shape — a slim, non-blocking banner carries the setup CTA over the board.
	const boardEmpty = isEmpty && data.series.length === 0;

	const ctx: TileContext = {
		summary: displaySummary,
		series: displaySeries,
		annotations: chartAnnotations,
		deltas: { pv: dPv, vis: dVis, ev: dEv },
		sparks: { pv: sparkPv, vis: sparkVis, ev: sparkEv },
		sense,
		flow,
		data,
		engagement: data.engagement,
		anyFilter,
		cubeFilter,
		serverFilter,
		toggleServer,
		dimRows,
		dimSelect,
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			{boardEmpty ? (
				<div className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-accent-200 bg-accent-50/70 px-4 py-2.5 text-sm text-accent-800">
					<span>No data yet — once your site sends events they will appear here.</span>
					<button
						type="button"
						onClick={onOpenSettings}
						className="shrink-0 rounded-lg bg-accent-600 px-3 py-1.5 font-medium text-white text-xs transition hover:bg-accent-700"
					>
						Set up a site
					</button>
				</div>
			) : (
				filterBar
			)}
			<BentoBoard
				ctx={ctx}
				siteId={siteId}
				footer={
					slice?.visitorsApproximate ? (
						<p className="shrink-0 text-xs text-neutral-400">
							Visitors is an upper bound under this slice; pageviews and events are
							exact.
						</p>
					) : null
				}
			/>
		</div>
	);
}

function Dashboard(): ReactElement {
	const { apiKey, siteId, preset, range } = useDashboard();
	const [view, setView] = useState<View>('overview');
	const [showSettings, setShowSettings] = useState(false);
	// The cube cross-filter lives here (not inside Overview) so it survives tab switches and can be set
	// from another tab — e.g. "Investigate" on an anomaly focuses the Overview on the culprit segment.
	const [cubeFilter, setCubeFilter] = useState<CubeFilter>({});
	// High-cardinality path/referrer filters go through the server (the cube deliberately excludes them).
	const [serverFilter, setServerFilter] = useState<ServerFilter>({});
	const investigate = (f: CubeFilter): void => {
		setCubeFilter(f);
		setServerFilter({});
		setView('overview');
	};
	const queryClient = useQueryClient();
	const prevSiteRef = useRef(siteId);

	// Switching site profile must not show the previous site's cached read data. Every read query is
	// keyed by site id, so a new site never reads another site's cache. On an actual switch we also
	// drop the PREVIOUS site's cached read queries so nothing stale lingers.
	useEffect(() => {
		const prevSite = prevSiteRef.current;
		if (prevSite === siteId) return;
		prevSiteRef.current = siteId;
		queryClient.removeQueries({
			predicate: (q) => queryKeyReferencesSite(q.queryKey, prevSite),
		});
	}, [siteId, queryClient]);

	// The Overview bento fills the viewport exactly (no page scroll); every other tab scrolls normally.
	const fill = !showSettings && view === 'overview';

	return (
		<Layout
			fill={fill}
			settingsActive={showSettings}
			onToggleSettings={() => setShowSettings((prev) => !prev)}
			headerExtra={
				showSettings ? null : (
					<ExportButton
						apiKey={apiKey}
						siteId={siteId}
						range={range}
						interval={preset === '24h' ? 'hour' : 'day'}
					/>
				)
			}
		>
			{showSettings ? (
				<Settings />
			) : (
				<>
					<div
						role="tablist"
						aria-label="Analytics views"
						className="mb-4 flex shrink-0 gap-1 overflow-x-auto border-b border-neutral-200"
					>
						{TABS.map((tab) => (
							<button
								key={tab.id}
								type="button"
								role="tab"
								aria-selected={view === tab.id}
								onClick={() => setView(tab.id)}
								className={cn(
									'-mb-px shrink-0 border-b-2 px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
									view === tab.id
										? 'border-accent-500 text-neutral-900'
										: 'border-transparent text-neutral-500 hover:text-neutral-800',
								)}
							>
								{tab.label}
							</button>
						))}
					</div>
					{view === 'overview' ? (
						<div className="flex min-h-0 flex-1 flex-col">
							<Overview
								onOpenSettings={() => setShowSettings(true)}
								filter={cubeFilter}
								onFilterChange={setCubeFilter}
								serverFilter={serverFilter}
								onServerFilterChange={setServerFilter}
							/>
						</div>
					) : view === 'realtime' ? (
						<Realtime apiKey={apiKey} siteId={siteId} />
					) : view === 'funnels' ? (
						<FunnelsView
							apiKey={apiKey}
							siteId={siteId}
							range={range}
							onOpenSettings={() => setShowSettings(true)}
						/>
					) : view === 'retention' ? (
						<Retention apiKey={apiKey} siteId={siteId} range={range} />
					) : view === 'experiments' ? (
						<Experiments
							apiKey={apiKey}
							siteId={siteId}
							range={range}
							onOpenSettings={() => setShowSettings(true)}
						/>
					) : view === 'anomalies' ? (
						<Anomalies
							apiKey={apiKey}
							siteId={siteId}
							range={range}
							onInvestigate={investigate}
						/>
					) : (
						<AskPanel apiKey={apiKey} siteId={siteId} range={range} />
					)}
				</>
			)}
		</Layout>
	);
}

export function App(): ReactElement {
	const { activeProfile } = useDashboard();
	if (!activeProfile) return <KeyGate />;
	return <Dashboard />;
}
