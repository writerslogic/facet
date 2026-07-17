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
import { EngagementCards } from './components/EngagementCards.js';
import { Experiments } from './components/Experiments.js';
import { FunnelsView } from './components/FunnelsView.js';
import { KeyGate } from './components/KeyGate.js';
import { KpiCards } from './components/KpiCards.js';
import { Layout } from './components/Layout.js';
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
import { useStats } from './hooks/stats.js';
import { cn } from './lib/cn.js';
import { isAuthError } from './lib/status.js';
import { useDashboard } from './state.js';

type View = 'overview' | 'funnels' | 'experiments' | 'anomalies' | 'ask';

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
	{ id: 'funnels', label: 'Funnels' },
	{ id: 'experiments', label: 'Experiments' },
	{ id: 'anomalies', label: 'Anomalies' },
	{ id: 'ask', label: 'Ask' },
];

function Overview({
	onOpenSettings,
}: {
	onOpenSettings: () => void;
}): ReactElement {
	const { apiKey, siteId, preset, range } = useDashboard();

	const query: StatsQuery = {
		site_id: siteId,
		start: range.start,
		end: range.end,
		interval: preset === '24h' ? 'hour' : 'day',
	};

	const { data, isLoading, error } = useStats(apiKey, query);

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

	return (
		<div className="space-y-6">
			{data.meta?.pending ? <PendingNotice /> : null}
			<KpiCards summary={summary} />
			<EngagementCards engagement={data.engagement} />
			<TrafficChart series={data.series} loading={false} error={null} />
			{isEmpty && data.series.length === 0 ? (
				<EmptyState title="No data yet">
					<span>
						Once your site sends events they will appear here.{' '}
						<button
							type="button"
							onClick={onOpenSettings}
							className="font-medium text-sky-600 underline hover:text-sky-800"
						>
							Set up a site in Settings
						</button>
						.
					</span>
				</EmptyState>
			) : (
				<>
					<ChannelsPanel channels={data.channels} />
					<Breakdowns stats={data} />
				</>
			)}
		</div>
	);
}

function Dashboard(): ReactElement {
	const { apiKey, siteId, range } = useDashboard();
	const [view, setView] = useState<View>('overview');
	const [showSettings, setShowSettings] = useState(false);
	const queryClient = useQueryClient();
	const prevSiteRef = useRef(siteId);

	// Switching site profile must not show the previous site's cached read data. Every read query is
	// keyed by site id, so a new site never reads another site's cache. On an actual switch we also
	// drop the PREVIOUS site's cached read queries so nothing stale lingers; the just-activated site's
	// own in-flight queries are untouched so the current fetch is never cancelled.
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
		>
			{showSettings ? (
				<Settings />
			) : (
				<>
					<div className="mb-6 flex gap-1 border-b border-neutral-200">
						{TABS.map((tab) => (
							<button
								key={tab.id}
								type="button"
								onClick={() => setView(tab.id)}
								className={cn(
									'-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
									view === tab.id
										? 'border-sky-500 text-neutral-900'
										: 'border-transparent text-neutral-500 hover:text-neutral-800',
								)}
							>
								{tab.label}
							</button>
						))}
					</div>
					{view === 'overview' ? (
						<Overview onOpenSettings={() => setShowSettings(true)} />
					) : view === 'funnels' ? (
						<FunnelsView
							apiKey={apiKey}
							siteId={siteId}
							range={range}
							onOpenSettings={() => setShowSettings(true)}
						/>
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
