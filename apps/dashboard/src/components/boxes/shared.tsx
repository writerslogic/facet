// Shared building blocks for boxes. `ListBody` is the ranked-list body used by every dimension box
// (pages, referrers, devices, channels, events): compact it is a bare, dark, size-fitting TopList;
// expanded it becomes `ListDetail` — a full, filterable, sortable drill-down over every row.

import type { CountRow } from '@facet/shared';
import { Search } from 'lucide-react';
import { type ReactNode, useDeferredValue, useMemo, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { formatNumber } from '../../lib/format.js';
import { TopList } from '../TopList.js';
import type { TableData, TileConfig, TileOption, TileVariant } from './types.js';

/** A shared "Color" option: pick one of the active palette's data colours for a box; boxes apply it to
 * their chart stroke + surface tint. Palette tokens resolve per theme, so a box stays on-palette. */
export const ACCENT_OPTION: TileOption = {
	key: 'accent',
	label: 'Color',
	type: 'color',
	choices: [
		{ value: 'auto', label: 'Auto (prism)' },
		{ value: 'var(--d1)', label: 'Indigo' },
		{ value: 'var(--d2)', label: 'Violet' },
		{ value: 'var(--d3)', label: 'Fuchsia' },
		{ value: 'var(--c4)', label: 'Cyan' },
		{ value: 'var(--c5)', label: 'Amber' },
		{ value: 'var(--pos)', label: 'Green' },
	],
	default: 'auto',
};

/** The explicit accent colour chosen for a box, or `undefined` for "auto" (keep the box's prism default).
 * A box passes this straight to a viz's `accent` prop — undefined means "use the built-in ramp". */
export function accentOf(config: TileConfig | undefined): string | undefined {
	const v = config?.accent;
	return typeof v === 'string' && v !== 'auto' ? v : undefined;
}

/** A ranked-list box's data as a table: name, count, and share-of-total percent. */
export function rowsTable(nameCol: string, rows: CountRow[]): TableData {
	const total = rows.reduce((s, r) => s + r.count, 0);
	return {
		columns: [nameCol, 'Count', 'Share %'],
		rows: rows.map((r) => [
			r.key,
			r.count,
			total > 0 ? Math.round((r.count / total) * 100) : 0,
		]),
	};
}

/** The chart styles a dimension list can wear (declared by every list box). */
export const LIST_VARIANTS: TileVariant[] = [
	{ id: 'bars', label: 'Bars' },
	{ id: 'donut', label: 'Donut' },
	{ id: 'table', label: 'Table' },
];

/** The customization options a dimension list exposes: how many rows to show, and an accent colour. */
export const LIST_OPTIONS: TileOption[] = [
	{
		key: 'rows',
		label: 'Rows',
		type: 'select',
		choices: [
			{ value: 'auto', label: 'Auto' },
			{ value: '5', label: 'Top 5' },
			{ value: '8', label: 'Top 8' },
			{ value: '12', label: 'Top 12' },
		],
		default: 'auto',
	},
	ACCENT_OPTION,
];

/** The row cap chosen for a list, or `undefined` for "auto" (height-fit bars, sensible default elsewhere). */
function rowLimitOf(config: TileConfig | undefined): number | undefined {
	const v = config?.rows;
	if (typeof v !== 'string' || v === 'auto') return undefined;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : undefined;
}

export function ListBody({
	title,
	rows,
	onSelect,
	activeKey,
	expanded,
	config,
}: {
	title: string;
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	expanded?: boolean;
	config?: TileConfig;
}): ReactNode {
	if (expanded) {
		return <ListDetail title={title} rows={rows} onSelect={onSelect} activeKey={activeKey} />;
	}
	const limit = rowLimitOf(config);
	const accent = accentOf(config);
	if (config?.variant === 'donut') {
		return (
			<DonutList
				rows={rows}
				onSelect={onSelect}
				activeKey={activeKey}
				accent={accent}
				limit={limit ?? 5}
			/>
		);
	}
	if (config?.variant === 'table') {
		return <MiniTable title={title} rows={rows} activeKey={activeKey} limit={limit} />;
	}
	// Default 'bars': the ranked TopList. With no explicit cap it height-fits; a cap disables fit.
	return (
		<TopList
			bare
			dark
			fit={limit === undefined}
			limit={limit ?? 6}
			title={title}
			rows={rows}
			onSelect={onSelect}
			activeKey={activeKey}
		/>
	);
}

/** Slice palette for the donut when no accent is chosen — the prism data hues, cycled. */
const SLICE_COLORS = [
	'var(--c1)',
	'var(--c2)',
	'var(--c3)',
	'var(--d1)',
	'var(--d2)',
	'var(--d3)',
] as const;

/** A donut of the top slices (plus an aggregated "Other"), with a clickable legend that cross-filters.
 * Accent-tinted when a colour is chosen, else prism-cycled. Legend hides on a narrow tile (donut stays). */
function DonutList({
	rows,
	onSelect,
	activeKey,
	accent,
	limit,
}: {
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	accent?: string;
	limit: number;
}): ReactNode {
	const total = rows.reduce((sum, r) => sum + r.count, 0);
	const top = rows.slice(0, limit);
	const otherCount = total - top.reduce((sum, r) => sum + r.count, 0);
	const slices = otherCount > 0 ? [...top, { key: 'Other', count: otherCount }] : top;
	const color = (i: number): string =>
		accent
			? `color-mix(in srgb, ${accent} ${Math.max(28, 100 - i * 16)}%, transparent)`
			: (SLICE_COLORS[i % SLICE_COLORS.length] ?? 'var(--c1)');
	if (total === 0) {
		return <p className="py-6 text-center text-sm text-neutral-500">No data yet</p>;
	}
	let acc = 0;
	return (
		<div className="flex h-full items-center gap-3">
			<div className="relative aspect-square h-full max-h-[9rem] min-h-0 shrink-0">
				<svg viewBox="0 0 42 42" className="-rotate-90 h-full w-full" aria-hidden="true">
					<circle
						cx="21"
						cy="21"
						r="15.915"
						fill="none"
						stroke="rgb(var(--hover))"
						strokeWidth="4.5"
					/>
					{slices.map((s, i) => {
						const pct = (s.count / total) * 100;
						const seg = (
							<circle
								key={s.key}
								cx="21"
								cy="21"
								r="15.915"
								fill="none"
								stroke={color(i)}
								strokeWidth="4.5"
								strokeDasharray={`${pct} ${100 - pct}`}
								strokeDashoffset={`${-acc}`}
								style={{
									transition:
										'stroke-dasharray 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
								}}
							/>
						);
						acc += pct;
						return seg;
					})}
				</svg>
				<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
					<span className="tabular font-semibold text-[color:var(--ink)] text-sm">
						{formatNumber(total)}
					</span>
					<span className="text-[9px] text-[color:var(--muted)] uppercase tracking-wide">
						total
					</span>
				</div>
			</div>
			<ul className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 @max-[13rem]/tile:hidden">
				{slices.map((s, i) => {
					const active = s.key === activeKey;
					const pct = Math.round((s.count / total) * 100);
					const clickable = Boolean(onSelect) && s.key !== 'Other';
					const inner = (
						<>
							<span
								className="size-2 shrink-0 rounded-[2px]"
								style={{ background: color(i) }}
								aria-hidden="true"
							/>
							<span
								className={cn(
									'min-w-0 truncate font-medium',
									active ? 'text-accent-200' : 'text-[color:var(--ink)]',
								)}
								title={s.key}
							>
								{s.key}
							</span>
							<span className="ml-auto shrink-0 text-[color:var(--muted)] tabular-nums">
								{pct}%
							</span>
						</>
					);
					const cls =
						'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px]';
					return (
						<li key={s.key}>
							{clickable ? (
								<button
									type="button"
									aria-pressed={active}
									onClick={() => onSelect?.(s.key)}
									className={cn(
										cls,
										'transition-colors hover:bg-[color:rgb(var(--hover))]',
										active && 'bg-[color:rgb(var(--hover))]',
									)}
								>
									{inner}
								</button>
							) : (
								<div className={cls}>{inner}</div>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/** A compact ranked table (key / count / share) for reading the raw numbers in place — a denser encoding
 * than the bars. Read-only; cross-filter lives on the bar + donut styles. */
function MiniTable({
	title,
	rows,
	activeKey,
	limit,
}: {
	title: string;
	rows: CountRow[];
	activeKey?: string;
	limit?: number;
}): ReactNode {
	const total = rows.reduce((sum, r) => sum + r.count, 0);
	const shown = limit ? rows.slice(0, limit) : rows;
	if (shown.length === 0) {
		return <p className="py-6 text-center text-sm text-neutral-500">No data yet</p>;
	}
	return (
		<div className="h-full overflow-auto">
			<table className="w-full text-[13px]">
				<thead className="sticky top-0 bg-[var(--panel)]">
					<tr className="text-[10px] text-[color:var(--muted)] uppercase tracking-wide">
						<th className="py-1 pr-2 text-left font-semibold">{title}</th>
						<th className="px-2 py-1 text-right font-semibold">Count</th>
						<th className="py-1 pl-2 text-right font-semibold">%</th>
					</tr>
				</thead>
				<tbody>
					{shown.map((r) => {
						const active = r.key === activeKey;
						const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
						return (
							<tr
								key={r.key}
								className={cn(
									'border-[color:rgb(var(--border))] border-t',
									active ? 'text-accent-200' : 'text-[color:var(--ink)]',
								)}
							>
								<td className="max-w-0 truncate py-1 pr-2" title={r.key}>
									{r.key}
								</td>
								<td className="px-2 py-1 text-right font-semibold tabular-nums">
									{formatNumber(r.count)}
								</td>
								<td className="py-1 pl-2 text-right text-[color:var(--muted)] tabular-nums">
									{pct}%
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

/** One summary figure in a list drill-down's header (total / distinct / top share). */
function DetailMetric({
	label,
	value,
}: {
	label: string;
	value: string;
}): ReactNode {
	return (
		<div className="min-w-0">
			<div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--muted)]">
				{label}
			</div>
			<div className="tabular truncate font-semibold text-[color:var(--ink)] text-sm">
				{value}
			</div>
		</div>
	);
}

/** The expanded drill-down for a dimension list: a summary strip (total, distinct keys, the leader's
 * share), a live substring filter, a Top ↔ A–Z sort toggle, and the FULL ranked list (scrolling), with
 * cross-filter clicks preserved. The header controls collapse away on a narrow tile so it stays legible
 * at any size. */
function ListDetail({
	title,
	rows,
	onSelect,
	activeKey,
}: {
	title: string;
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
}): ReactNode {
	const [query, setQuery] = useState('');
	const [alpha, setAlpha] = useState(false);
	const deferredQuery = useDeferredValue(query);
	const total = rows.reduce((sum, r) => sum + r.count, 0);
	const view = useMemo(() => {
		const q = deferredQuery.trim().toLowerCase();
		const filtered = q ? rows.filter((r) => r.key.toLowerCase().includes(q)) : rows;
		return alpha ? [...filtered].sort((a, b) => a.key.localeCompare(b.key)) : filtered;
	}, [rows, deferredQuery, alpha]);
	const leader = rows[0];
	const topShare = total > 0 && leader ? Math.round((leader.count / total) * 100) : 0;
	return (
		<div className="flex h-full flex-col gap-3">
			<div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2">
				<DetailMetric label="Total" value={formatNumber(total)} />
				<DetailMetric label="Distinct" value={formatNumber(rows.length)} />
				{leader ? (
					<DetailMetric label={`Top · ${leader.key}`} value={`${topShare}%`} />
				) : null}
				<div className="ml-auto flex items-center gap-2">
					<label className="relative flex items-center @max-[24rem]/tile:hidden">
						<Search
							className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[color:var(--faint)]"
							aria-hidden="true"
						/>
						<input
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Filter"
							aria-label={`Filter ${title}`}
							className="w-40 rounded-lg border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] py-1 pr-2 pl-7 text-sm text-[color:var(--ink)] placeholder:text-[color:var(--faint)] focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
						/>
					</label>
					<button
						type="button"
						onClick={() => setAlpha((v) => !v)}
						aria-pressed={alpha}
						aria-label={`Sort ${alpha ? 'by count' : 'alphabetically'}`}
						className="shrink-0 rounded-lg border border-[color:rgb(var(--border))] px-2 py-1 text-[11px] font-medium text-[color:var(--muted)] transition hover:text-[color:var(--ink)]"
					>
						{alpha ? 'A–Z' : 'Top'}
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{view.length === 0 ? (
					<p className="py-6 text-center text-sm text-neutral-500">No matches</p>
				) : (
					<TopList
						bare
						dark
						title={title}
						rows={view}
						onSelect={onSelect}
						activeKey={activeKey}
					/>
				)}
			</div>
		</div>
	);
}
