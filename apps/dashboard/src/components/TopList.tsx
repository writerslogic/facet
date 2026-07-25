// Top-N breakdown list: proportional horizontal bars whose width tracks the max count. Values are
// right-aligned and tabular; long keys truncate with a title tooltip. Pure CSS/Tailwind, no chart lib.
// When `onSelect` is supplied, rows become toggle buttons that cross-filter the dashboard.

import type { CountRow } from '@facet/shared';
import { Check } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/cn.js';
import { formatNumber } from '../lib/format.js';
import { Card, CardHeading } from './Card.js';

interface TopListProps {
	title: string;
	rows: CountRow[];
	action?: ReactElement;
	/** When provided, rows become toggle buttons that cross-filter the dashboard by their key. */
	onSelect?: (key: string) => void;
	/** The currently-filtered key for this dimension: highlighted, and toggled off on re-click. */
	activeKey?: string;
	/** Render just the list (no Card/heading) — the caller (e.g. a bento tile) supplies the frame. */
	bare?: boolean;
	/** Cap the number of rows shown. */
	limit?: number;
	/** Style for the dark "cut obsidian" board (light text + luminous bars). Default is the light theme
	 * used by the other tabs. */
	dark?: boolean;
}

export function TopList({
	title,
	rows,
	action,
	onSelect,
	activeKey,
	bare = false,
	limit,
	dark = false,
}: TopListProps): ReactElement {
	const shown = limit ? rows.slice(0, limit) : rows;
	const max = shown.reduce((acc, row) => Math.max(acc, row.count), 0);
	// Share is of the WHOLE dataset (all rows), not just the shown top-N, so a row's % reads as its
	// true portion of traffic rather than its portion of the visible slice.
	const total = rows.reduce((acc, row) => acc + row.count, 0);
	const interactive = Boolean(onSelect);
	// Per-theme colour tokens: the dark board wants light text + luminous bars; the light tabs keep the
	// original ink-on-white treatment.
	const c = dark
		? {
				empty: 'text-neutral-500',
				barActive: 'bg-accent-400/45',
				bar: 'bg-accent-500/20 group-hover:bg-accent-500/30',
				keyActive: 'text-accent-200',
				key: 'text-neutral-200',
				pct: 'text-neutral-500',
				value: 'text-neutral-50',
				rowHover: 'hover:bg-white/5',
				ring: 'ring-accent-400/40',
			}
		: {
				empty: 'text-neutral-400',
				barActive: 'bg-accent-300/60',
				bar: 'bg-accent-100/70 group-hover:bg-accent-200/70',
				keyActive: 'text-accent-800',
				key: 'text-neutral-700',
				pct: 'text-neutral-400',
				value: 'text-neutral-900',
				rowHover: 'hover:bg-neutral-50/80',
				ring: 'ring-accent-300',
			};
	const cls =
		'group relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-lg px-2.5 py-2 text-left text-sm transition-colors';

	const body =
		shown.length === 0 ? (
			<p className={cn('py-6 text-center text-sm', c.empty)}>No data yet</p>
		) : (
			<ul className="space-y-0.5">
				{shown.map((row) => {
					const width = max > 0 ? (row.count / max) * 100 : 0;
					const active = row.key === activeKey;
					const inner = (
						<>
							<span
								className={cn(
									'absolute inset-y-1 left-0 rounded-md transition-[width] duration-500 ease-out',
									active ? c.barActive : c.bar,
								)}
								style={{ width: `${width}%` }}
								data-testid="toplist-bar"
								aria-hidden="true"
							/>
							<span
								className={cn(
									'relative z-10 flex min-w-0 items-center gap-1.5 font-medium',
									active ? c.keyActive : c.key,
								)}
								title={row.key}
							>
								{active ? (
									<Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
								) : null}
								<span className="truncate">{row.key}</span>
							</span>
							<span className="relative z-10 flex shrink-0 items-baseline gap-1.5">
								<span className={cn('text-[11px] tabular-nums', c.pct)}>
									{total > 0 ? Math.round((row.count / total) * 100) : 0}%
								</span>
								<span className={cn('font-semibold tabular-nums', c.value)}>
									{formatNumber(row.count)}
								</span>
							</span>
						</>
					);
					return (
						<li key={row.key}>
							{interactive ? (
								<button
									type="button"
									aria-pressed={active}
									onClick={() => onSelect?.(row.key)}
									className={cn(
										cls,
										c.rowHover,
										'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40',
										active && cn('ring-1', c.ring),
									)}
								>
									{inner}
								</button>
							) : (
								<div className={cn(cls, c.rowHover)}>{inner}</div>
							)}
						</li>
					);
				})}
			</ul>
		);

	if (bare) {
		return body;
	}
	return (
		<Card>
			<CardHeading action={action}>{title}</CardHeading>
			{body}
		</Card>
	);
}
