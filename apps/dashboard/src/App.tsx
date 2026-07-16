// Root dashboard component: KeyGate until credentials are stored, otherwise the app shell
// with KPI cards, traffic chart, and breakdowns driven by the stats query.

import type { StatsQuery } from '@countless/shared';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { Breakdowns } from './components/Breakdowns.js';
import { ChannelsPanel } from './components/ChannelsPanel.js';
import { EngagementCards } from './components/EngagementCards.js';
import { Experiments } from './components/Experiments.js';
import { FunnelsView } from './components/FunnelsView.js';
import { KeyGate } from './components/KeyGate.js';
import { KpiCards } from './components/KpiCards.js';
import { Layout } from './components/Layout.js';
import { TrafficChart } from './components/TrafficChart.js';
import { useStats } from './hooks/stats.js';
import { cn } from './lib/cn.js';
import { useDashboard } from './state.js';

type View = 'overview' | 'funnels' | 'experiments';

const TABS: { id: View; label: string }[] = [
	{ id: 'overview', label: 'Overview' },
	{ id: 'funnels', label: 'Funnels' },
	{ id: 'experiments', label: 'Experiments' },
];

function Overview(): ReactElement {
	const { apiKey, siteId, preset, range } = useDashboard();

	const query: StatsQuery = {
		site_id: siteId,
		start: range.start,
		end: range.end,
		interval: preset === '24h' ? 'hour' : 'day',
	};

	const { data, isLoading, error } = useStats(apiKey, query);
	const errorMessage = error instanceof Error ? error.message : null;

	return (
		<div className="space-y-6">
			<KpiCards summary={data?.summary ?? { pageviews: 0, visitors: 0, events: 0 }} />
			<EngagementCards
				engagement={
					data?.engagement ?? {
						sessions: 0,
						bounce_rate: 0,
						pages_per_session: 0,
						avg_duration_ms: 0,
					}
				}
			/>
			<TrafficChart series={data?.series ?? []} loading={isLoading} error={errorMessage} />
			{data ? (
				<>
					<ChannelsPanel channels={data.channels} />
					<Breakdowns stats={data} />
				</>
			) : (
				<p className="text-sm text-neutral-400">{errorMessage ?? 'Loading breakdowns…'}</p>
			)}
		</div>
	);
}

function Dashboard(): ReactElement {
	const { apiKey, siteId, range } = useDashboard();
	const [view, setView] = useState<View>('overview');

	return (
		<Layout>
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
				<Overview />
			) : view === 'funnels' ? (
				<FunnelsView apiKey={apiKey} siteId={siteId} range={range} />
			) : (
				<Experiments apiKey={apiKey} siteId={siteId} range={range} />
			)}
		</Layout>
	);
}

export function App(): ReactElement {
	const { apiKey, siteId } = useDashboard();
	if (!apiKey || !siteId) return <KeyGate />;
	return <Dashboard />;
}
