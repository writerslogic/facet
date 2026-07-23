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
import { Breakdowns } from './components/Breakdowns.js';
import { ChannelsPanel } from './components/ChannelsPanel.js';
import { CubeFilterBar } from './components/CubeFilterBar.js';
import { EngagementCards } from './components/EngagementCards.js';
import { Experiments } from './components/Experiments.js';
import { ExportButton } from './components/ExportButton.js';
import { FunnelsView } from './components/FunnelsView.js';
import { InteractionsPanel } from './components/InteractionsPanel.js';
import { KeyGate } from './components/KeyGate.js';
import { KpiCards } from './components/KpiCards.js';
import { Layout } from './components/Layout.js';
import { Realtime } from './components/Realtime.js';
import { Retention } from './components/Retention.js';
import { Settings } from './components/Settings.js';
import {
	AuthErrorBanner,
	CardSkeletons,
	EmptyState,
	ErrorState,
	PendingNotice,
	Skeleton,
} from './components/StatusStates.js';
import { TrafficChart } from './components/TrafficChart.js';
import { VerifiedMetric } from './components/VerifiedMetric.js';
import { useCube } from './hooks/cube.js';
import { useCompareStats, useStats } from './hooks/stats.js';
import { cn } from './lib/cn.js';
import { type CubeFilter, cubeSeries, isFilterActive, sliceCube } from './lib/cube.js';
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
}: {
	onOpenSettings: () => void;
}): ReactElement {
	const { apiKey, siteId, preset, range, compare, compareRange } = useDashboard();
	const interval = preset === '24h' ? 'hour' : 'day';

	const query: StatsQuery = {
		site_id: siteId,
		start: range.start,
		end: range.end,
		interval,
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
	const [cubeFilter, setCubeFilter] = useState<CubeFilter>({});

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
	const filtered = isFilterActive(cubeFilter);
	const slice = filtered ? sliceCube(cubeCells, cubeFilter) : null;
	const displaySummary = slice
		? {
				pageviews: slice.pageviews,
				visitors: slice.visitors,
				events: slice.events,
			}
		: summary;
	const displaySeries = filtered ? cubeSeries(cubeCells, cubeFilter) : data.series;

	return (
		<div className="space-y-6">
			{data.meta?.pending ? <PendingNotice /> : null}
			<CubeFilterBar cells={cubeCells} filter={cubeFilter} onChange={setCubeFilter} />
			<VerifiedMetric label="Overview metrics">
				<KpiCards
					summary={displaySummary}
					compare={filtered ? undefined : cmp?.summary}
					series={displaySeries}
				/>
			</VerifiedMetric>
			{slice?.visitorsApproximate ? (
				<p className="-mt-3 text-xs text-neutral-400">
					Visitors is an upper bound under this slice (a visitor counted in more than one
					cell); pageviews and events are exact.
				</p>
			) : null}
			{filtered ? null : (
				<EngagementCards engagement={data.engagement} compare={cmp?.engagement} />
			)}
			<TrafficChart series={displaySeries} loading={false} error={null} />
			{isEmpty && data.series.length === 0 ? (
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
			) : (
				<>
					<ChannelsPanel channels={data.channels} />
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
						<InteractionsPanel apiKey={apiKey} siteId={siteId} range={range} />
					</div>
					<Breakdowns
						stats={data}
						cells={cubeCells}
						filter={cubeFilter}
						onFilterChange={setCubeFilter}
					/>
				</>
			)}
		</div>
	);
}

function Dashboard(): ReactElement {
	const { apiKey, siteId, preset, range } = useDashboard();
	const [view, setView] = useState<View>('overview');
	const [showSettings, setShowSettings] = useState(false);
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
						<Overview onOpenSettings={() => setShowSettings(true)} />
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
						<Anomalies apiKey={apiKey} siteId={siteId} range={range} />
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
