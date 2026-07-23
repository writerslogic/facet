// Breakdown grid: reuses TopList for each dimension. Country and Device are backed by the in-memory
// cube, so they cross-filter the whole dashboard on click and re-rank live under the active filter;
// Pages / Referrers / Custom Events are not cube dimensions, so they stay server-exact and static.

import type { CubeCell, StatsResponse } from '@facet/shared';
import type { ReactElement } from 'react';
import { type CubeAxis, type CubeFilter, cubeBreakdown } from '../lib/cube.js';
import { TopList } from './TopList.js';

export function Breakdowns({
	stats,
	cells,
	filter,
	onFilterChange,
}: {
	stats: StatsResponse;
	cells: CubeCell[];
	filter: CubeFilter;
	onFilterChange: (f: CubeFilter) => void;
}): ReactElement {
	const hasCube = cells.length > 0;
	const toggle = (axis: CubeAxis) => (key: string) =>
		onFilterChange({
			...filter,
			[axis]: filter[axis] === key ? undefined : key,
		});

	return (
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
			<TopList title="Top Pages" rows={stats.top_paths} />
			<TopList title="Top Referrers" rows={stats.top_referrers} />
			<TopList title="Custom Events" rows={stats.top_events} />
			<TopList
				title="Top Countries"
				rows={hasCube ? cubeBreakdown(cells, filter, 'country') : stats.top_countries}
				onSelect={hasCube ? toggle('country') : undefined}
				activeKey={filter.country}
			/>
			<TopList
				title="Devices"
				rows={hasCube ? cubeBreakdown(cells, filter, 'device') : stats.top_devices}
				onSelect={hasCube ? toggle('device') : undefined}
				activeKey={filter.device}
			/>
		</div>
	);
}
