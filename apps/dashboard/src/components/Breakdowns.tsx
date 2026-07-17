// Breakdown grid: reuses TopList for each dimension of the stats response.

import type { StatsResponse } from '@facet/shared';
import type { ReactElement } from 'react';
import { TopList } from './TopList.js';

export function Breakdowns({ stats }: { stats: StatsResponse }): ReactElement {
	return (
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
			<TopList title="Top Pages" rows={stats.top_paths} />
			<TopList title="Top Referrers" rows={stats.top_referrers} />
			<TopList title="Custom Events" rows={stats.top_events} />
			<TopList title="Top Countries" rows={stats.top_countries} />
			<TopList title="Devices" rows={stats.top_devices} />
		</div>
	);
}
