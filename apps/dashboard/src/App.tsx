// Root dashboard component: KeyGate until credentials are stored, otherwise the app shell
// with KPI cards, traffic chart, and breakdowns driven by the stats query.

import type { StatsQuery } from '@countless/shared';
import type { ReactElement } from 'react';
import { Breakdowns } from './components/Breakdowns.js';
import { KeyGate } from './components/KeyGate.js';
import { KpiCards } from './components/KpiCards.js';
import { Layout } from './components/Layout.js';
import { TrafficChart } from './components/TrafficChart.js';
import { useStats } from './hooks/stats.js';
import { useDashboard } from './state.js';

function Dashboard(): ReactElement {
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
		<Layout>
			<div className="space-y-6">
				<KpiCards summary={data?.summary ?? { pageviews: 0, visitors: 0, events: 0 }} />
				<TrafficChart
					series={data?.series ?? []}
					loading={isLoading}
					error={errorMessage}
				/>
				{data ? (
					<Breakdowns stats={data} />
				) : (
					<p className="text-sm text-neutral-400">
						{errorMessage ?? 'Loading breakdowns…'}
					</p>
				)}
			</div>
		</Layout>
	);
}

export function App(): ReactElement {
	const { apiKey, siteId } = useDashboard();
	if (!apiKey || !siteId) return <KeyGate />;
	return <Dashboard />;
}
