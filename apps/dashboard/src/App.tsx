// Root dashboard component: KeyGate until at least one site profile exists, otherwise the app shell
// with the read tabs plus a self-service Settings area. Read queries are keyed by site id, and the
// react-query cache is reset when the active profile changes so one site's data never flashes under
// another site's label.

import type { StatsQuery } from '@facet/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Anomalies } from './components/Anomalies.js';
import { AskPanel } from './components/AskPanel.js';
import { BentoTile, KpiTile } from './components/BentoTile.js';
import { CubeFilterBar } from './components/CubeFilterBar.js';
import { Experiments } from './components/Experiments.js';
import { ExportButton } from './components/ExportButton.js';
import { FunnelsView } from './components/FunnelsView.js';
import { KeyGate } from './components/KeyGate.js';
import { Layout } from './components/Layout.js';
import { Realtime } from './components/Realtime.js';
import { Retention } from './components/Retention.js';
import { Sankey } from './components/Sankey.js';
import { Settings } from './components/Settings.js';
import {
	AuthErrorBanner,
	CardSkeletons,
	EmptyState,
	ErrorState,
	Skeleton,
} from './components/StatusStates.js';
import { TopList } from './components/TopList.js';
import { TrafficChart } from './components/TrafficChart.js';
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
import { useDashboard } from './state.js';

type View = 'overview' | 'realtime' | 'funnels' | 'retention' | 'experiments' | 'anomalies' | 'ask';

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
	const compareStats = useCompareStats(apiKey, compareQuery, Boolean(compare && compareRange));
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
			<div className="space-y-6">
				<CardSkeletons count={3} />
				<CardSkeletons count={4} />
				<Skeleton className="h-[280px] w-full" />
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
	const cubeCells = cube.data?.cells ?? [];
	// In serverMode the fetched `data` is already fully filtered server-side, so use it directly; else
	// the cube slices client-side. `anyFilter` gates engagement + the compare column.
	const cubeActive = isFilterActive(cubeFilter) && !serverMode;
	const anyFilter = cubeActive || serverMode;
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

	if (isEmpty && data.series.length === 0) {
		return (
			<div className="flex min-h-0 flex-1 flex-col gap-3">
				{filterBar}
				<EmptyState title="No data yet">
					<span>
						Once your site sends events they will appear here.{' '}
						<button
							type="button"
							onClick={onOpenSettings}
							className="font-medium text-accent-600 underline hover:text-accent-800"
						>
							Set up a site in Settings
						</button>
						.
					</span>
				</EmptyState>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-col gap-3 lg:h-[calc(100dvh-10rem)]">
			{filterBar}
			<div className="grid min-h-0 flex-1 grid-cols-2 gap-3 lg:grid-cols-6 lg:grid-rows-6">
				<BentoTile
					label="Traffic over time"
					className="col-span-2 row-span-2 lg:col-span-4 lg:row-span-3"
					action={
						chartAnnotations.length > 0 ? (
							<span className="inline-flex items-center gap-1 text-[11px] text-neutral-400">
								<span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500" />
								Anomaly
							</span>
						) : null
					}
				>
					<TrafficChart
						bare
						series={displaySeries}
						annotations={chartAnnotations}
						loading={false}
						error={null}
					/>
				</BentoTile>

				<BentoTile className="col-span-1 lg:col-span-2 lg:row-span-2">
					<KpiTile
						label="Pageviews"
						value={displaySummary.pageviews}
						deltaPct={dPv}
						deltaSense={sense(dPv)}
						spark={sparkPv}
						stroke="#0f172a"
					/>
				</BentoTile>
				<BentoTile className="col-span-1 lg:col-span-1 lg:row-span-2">
					<KpiTile
						label="Visitors"
						value={displaySummary.visitors}
						deltaPct={dVis}
						deltaSense={sense(dVis)}
						spark={sparkVis}
						stroke="#6366f1"
					/>
				</BentoTile>
				<BentoTile className="col-span-2 lg:col-span-1 lg:row-span-2">
					<KpiTile
						label="Events"
						value={displaySummary.events}
						deltaPct={dEv}
						deltaSense={sense(dEv)}
						stroke="#8b5cf6"
					/>
				</BentoTile>

				<BentoTile label="Traffic flow" className="col-span-2 lg:col-span-3 lg:row-span-3">
					{flow.links.length > 0 ? (
						<Sankey nodes={flow.nodes} links={flow.links} />
					) : (
						<div className="flex h-full items-center justify-center text-sm text-neutral-400">
							No flow data yet
						</div>
					)}
				</BentoTile>
				<BentoTile
					label="Top pages"
					className="col-span-2 lg:col-span-3 lg:row-span-2"
					bodyClassName="overflow-y-auto"
				>
					<TopList
						bare
						limit={6}
						title="Top pages"
						rows={data.top_paths}
						onSelect={toggleServer('path')}
						activeKey={serverFilter.path}
					/>
				</BentoTile>
				<BentoTile
					label="Countries"
					className="col-span-2 lg:col-span-3 lg:row-span-1"
					bodyClassName="overflow-y-auto"
				>
					<TopList
						bare
						limit={4}
						title="Countries"
						rows={dimRows('country', data.top_countries)}
						onSelect={dimSelect('country')}
						activeKey={cubeFilter.country}
					/>
				</BentoTile>
			</div>
			{slice?.visitorsApproximate ? (
				<p className="shrink-0 text-xs text-neutral-400">
					Visitors is an upper bound under this slice; pageviews and events are exact.
				</p>
			) : null}
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

	return (
		<Layout
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
						className="mb-6 flex gap-1 overflow-x-auto border-b border-neutral-200"
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
						<Overview
							onOpenSettings={() => setShowSettings(true)}
							filter={cubeFilter}
							onFilterChange={setCubeFilter}
							serverFilter={serverFilter}
							onServerFilterChange={setServerFilter}
						/>
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
