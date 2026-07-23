// The active-filter bar. Device / country / channel are cube dimensions (instant client slice) shown
// as selects; path / referrer are server-side drill-downs set by clicking a breakdown row. Every active
// filter — cube OR server — appears as a removable chip so the current cross-filter is visible at a
// glance, with one "Clear all" that resets both.

import type { CubeCell } from '@facet/shared';
import { X } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/cn.js';
import { type CubeFilter, type ServerFilter, cubeDimensions, isFilterActive } from '../lib/cube.js';

const AXES: { key: keyof CubeFilter; label: string }[] = [
	{ key: 'device', label: 'Device' },
	{ key: 'country', label: 'Country' },
	{ key: 'channel', label: 'Channel' },
];

const SERVER_AXES: { key: keyof ServerFilter; label: string }[] = [
	{ key: 'path', label: 'Path' },
	{ key: 'referrer', label: 'Referrer' },
];

function Chip({
	label,
	value,
	onRemove,
}: {
	label: string;
	value: string;
	onRemove: () => void;
}): ReactElement {
	return (
		<button
			type="button"
			onClick={onRemove}
			className={cn(
				'inline-flex max-w-[22ch] items-center gap-1 rounded-full bg-accent-50 px-2 py-0.5 text-xs font-medium text-accent-700 ring-1 ring-accent-200',
				'transition hover:bg-accent-100',
			)}
			title={`Remove ${label} filter`}
		>
			<span className="text-accent-500">{label}:</span>
			<span className="truncate">{value}</span>
			<X className="h-3 w-3 shrink-0" aria-hidden="true" />
		</button>
	);
}

export function CubeFilterBar({
	cells,
	filter,
	onChange,
	serverFilter,
	onServerChange,
}: {
	cells: CubeCell[];
	filter: CubeFilter;
	onChange: (f: CubeFilter) => void;
	serverFilter: ServerFilter;
	onServerChange: (f: ServerFilter) => void;
}): ReactElement | null {
	const serverActive = Boolean(serverFilter.path || serverFilter.referrer);
	if (cells.length === 0 && !serverActive) return null;
	const dims = cubeDimensions(cells);
	const active = isFilterActive(filter) || serverActive;

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-neutral-200/70 bg-white px-4 py-2.5 text-sm shadow-card ring-1 ring-neutral-900/5">
			<span className="text-[13px] font-medium text-neutral-500">Slice</span>
			{cells.length > 0
				? AXES.map(({ key, label }) => (
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
					))
				: null}
			{active ? (
				<span className="ml-auto flex flex-wrap items-center gap-1.5">
					{AXES.filter(({ key }) => filter[key] !== undefined).map(({ key, label }) => (
						<Chip
							key={key}
							label={label}
							value={filter[key] as string}
							onRemove={() => onChange({ ...filter, [key]: undefined })}
						/>
					))}
					{SERVER_AXES.filter(({ key }) => serverFilter[key] !== undefined).map(
						({ key, label }) => (
							<Chip
								key={key}
								label={label}
								value={serverFilter[key] as string}
								onRemove={() =>
									onServerChange({
										...serverFilter,
										[key]: undefined,
									})
								}
							/>
						),
					)}
					<button
						type="button"
						onClick={() => {
							onChange({});
							onServerChange({});
						}}
						className="text-xs font-medium text-neutral-500 underline hover:text-neutral-800"
					>
						Clear all
					</button>
				</span>
			) : null}
		</div>
	);
}
