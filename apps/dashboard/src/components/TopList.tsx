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
}

export function TopList({
	title,
	rows,
	action,
	onSelect,
	activeKey,
	bare = false,
	limit,
}: TopListProps): ReactElement {
	const shown = limit ? rows.slice(0, limit) : rows;
	const max = shown.reduce((acc, row) => Math.max(acc, row.count), 0);
	const interactive = Boolean(onSelect);
	const cls =
		'group relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-lg px-2.5 py-2 text-left text-sm transition-colors';

	const body =
		shown.length === 0 ? (
			<p className="py-6 text-center text-sm text-neutral-400">No data yet</p>
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
									active
										? 'bg-accent-300/60'
										: 'bg-accent-100/70 group-hover:bg-accent-200/70',
								)}
								style={{ width: `${width}%` }}
								data-testid="toplist-bar"
								aria-hidden="true"
							/>
							<span
								className={cn(
									'relative z-10 flex min-w-0 items-center gap-1.5 font-medium',
									active ? 'text-accent-800' : 'text-neutral-700',
								)}
								title={row.key}
							>
								{active ? (
									<Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
								) : null}
								<span className="truncate">{row.key}</span>
							</span>
							<span className="relative z-10 shrink-0 font-semibold text-neutral-900 tabular-nums">
								{formatNumber(row.count)}
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
										'hover:bg-neutral-50/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40',
										active && 'ring-1 ring-accent-300',
									)}
								>
									{inner}
								</button>
							) : (
								<div className={cn(cls, 'hover:bg-neutral-50/80')}>{inner}</div>
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
