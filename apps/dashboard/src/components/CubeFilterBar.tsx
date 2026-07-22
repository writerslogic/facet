// Device / country / channel filter controls over the in-memory cube. Changing a selection re-slices the
// cube on the client (lib/cube.ts) — the KPIs and chart update within a frame, with no server round-trip.

import type { CubeCell } from '@facet/shared';
import type { ReactElement } from 'react';
import { type CubeFilter, cubeDimensions, isFilterActive } from '../lib/cube.js';

const AXES: { key: keyof CubeFilter; label: string }[] = [
	{ key: 'device', label: 'Device' },
	{ key: 'country', label: 'Country' },
	{ key: 'channel', label: 'Channel' },
];

export function CubeFilterBar({
	cells,
	filter,
	onChange,
}: {
	cells: CubeCell[];
	filter: CubeFilter;
	onChange: (f: CubeFilter) => void;
}): ReactElement | null {
	if (cells.length === 0) return null;
	const dims = cubeDimensions(cells);
	const active = isFilterActive(filter);

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-neutral-200/80 bg-white px-4 py-2.5 text-sm shadow-sm">
			<span className="text-[13px] font-medium text-neutral-500">Slice</span>
			{AXES.map(({ key, label }) => (
				<label key={key} className="flex items-center gap-1.5">
					<span className="text-xs text-neutral-500">{label}</span>
					<select
						value={filter[key] ?? ''}
						onChange={(e) =>
							onChange({
								...filter,
								[key]: e.target.value || undefined,
							})
						}
						className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-800 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
					>
						<option value="">All</option>
						{dims[key].map((v) => (
							<option key={v} value={v}>
								{v}
							</option>
						))}
					</select>
				</label>
			))}
			{active ? (
				<>
					<button
						type="button"
						onClick={() => onChange({})}
						className="text-xs font-medium text-accent-600 underline hover:text-accent-800"
					>
						Clear
					</button>
					<span className="text-xs text-emerald-600">instant · no server round-trip</span>
				</>
			) : null}
		</div>
	);
}
