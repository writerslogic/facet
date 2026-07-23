// Breakdown grid. Every list cross-filters the dashboard on click:
//   • Country / Device are cube dimensions — instant client slice, re-ranking live under the filter
//     (and, in serverMode, re-fetched server-side so they combine with a path/referrer drill-down).
//   • Pages / Referrers are high-cardinality, so clicking one is a SERVER-side drill-down (a refetch):
//     the whole Overview re-scopes to that path/referrer. Custom Events stays a static readout.

import type { CubeCell, StatsResponse } from '@facet/shared';
import type { ReactElement } from 'react';
import { type CubeAxis, type CubeFilter, type ServerFilter, cubeBreakdown } from '../lib/cube.js';
import { TopList } from './TopList.js';

export function Breakdowns({
	stats,
	cells,
	filter,
	onFilterChange,
	serverFilter,
	onServerFilterChange,
	serverMode,
}: {
	stats: StatsResponse;
	cells: CubeCell[];
	filter: CubeFilter;
	onFilterChange: (f: CubeFilter) => void;
	serverFilter: ServerFilter;
	onServerFilterChange: (f: ServerFilter) => void;
	serverMode: boolean;
}): ReactElement {
	const hasCube = cells.length > 0;
	const toggleCube = (axis: CubeAxis) => (key: string) =>
		onFilterChange({
			...filter,
			[axis]: filter[axis] === key ? undefined : key,
		});
	const toggleServer = (key: keyof ServerFilter) => (value: string) =>
		onServerFilterChange({
			...serverFilter,
			[key]: serverFilter[key] === value ? undefined : value,
		});
	// Country/Device are cube-derived when possible (switchable), but come from the server response once
	// a path/referrer drill-down is active — then they reflect (and re-fetch under) that filter.
	const dimRows = (axis: CubeAxis, server: StatsResponse['top_countries']) =>
		!serverMode && hasCube ? cubeBreakdown(cells, filter, axis) : server;
	const dimSelect = (axis: CubeAxis) => (serverMode || hasCube ? toggleCube(axis) : undefined);

	return (
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
			<TopList
				title="Top Pages"
				rows={stats.top_paths}
				onSelect={toggleServer('path')}
				activeKey={serverFilter.path}
			/>
			<TopList
				title="Top Referrers"
				rows={stats.top_referrers}
				onSelect={toggleServer('referrer')}
				activeKey={serverFilter.referrer}
			/>
			<TopList title="Custom Events" rows={stats.top_events} />
			<TopList
				title="Top Countries"
				rows={dimRows('country', stats.top_countries)}
				onSelect={dimSelect('country')}
				activeKey={filter.country}
			/>
			<TopList
				title="Devices"
				rows={dimRows('device', stats.top_devices)}
				onSelect={dimSelect('device')}
				activeKey={filter.device}
			/>
		</div>
	);
}
