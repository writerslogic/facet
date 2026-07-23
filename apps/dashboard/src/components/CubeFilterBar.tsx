// Device / country / channel filter controls over the in-memory cube. Changing a selection — from the
// selects here OR by clicking a breakdown row — re-slices the cube on the client (lib/cube.ts): the
// KPIs, chart, and cube-backed breakdowns update within a frame, with no server round-trip. Active
// axes also appear as removable chips so the current cross-filter is always visible at a glance.

import type { CubeCell } from '@facet/shared';
import { X } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/cn.js';
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
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-neutral-200/70 bg-white px-4 py-2.5 text-sm shadow-card ring-1 ring-neutral-900/5">
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
				<span className="ml-auto flex flex-wrap items-center gap-1.5">
					{AXES.filter(({ key }) => filter[key] !== undefined).map(({ key, label }) => (
						<button
							key={key}
							type="button"
							onClick={() => onChange({ ...filter, [key]: undefined })}
							className={cn(
								'inline-flex items-center gap-1 rounded-full bg-accent-50 px-2 py-0.5 text-xs font-medium text-accent-700 ring-1 ring-accent-200',
								'transition hover:bg-accent-100',
							)}
							title={`Remove ${label} filter`}
						>
							<span className="text-accent-500">{label}:</span>
							{filter[key]}
							<X className="h-3 w-3" aria-hidden="true" />
						</button>
					))}
					<button
						type="button"
						onClick={() => onChange({})}
						className="text-xs font-medium text-neutral-500 underline hover:text-neutral-800"
					>
						Clear all
					</button>
				</span>
			) : null}
		</div>
	);
}
