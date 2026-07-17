// Top-N breakdown list: proportional horizontal bars whose width tracks the max count. Values are
// right-aligned and tabular; long keys truncate with a title tooltip. Pure CSS/Tailwind, no chart lib.

import type { CountRow } from '@facet/shared';
import type { ReactElement } from 'react';
import { formatNumber } from '../lib/format.js';
import { Card, CardHeading } from './Card.js';

interface TopListProps {
	title: string;
	rows: CountRow[];
	action?: ReactElement;
}

export function TopList({ title, rows, action }: TopListProps): ReactElement {
	const max = rows.reduce((acc, row) => Math.max(acc, row.count), 0);

	return (
		<Card>
			<CardHeading action={action}>{title}</CardHeading>
			{rows.length === 0 ? (
				<p className="py-6 text-center text-sm text-neutral-400">No data yet</p>
			) : (
				<ul className="space-y-0.5">
					{rows.map((row) => {
						const width = max > 0 ? (row.count / max) * 100 : 0;
						return (
							<li
								key={row.key}
								className="group relative flex items-center justify-between gap-3 overflow-hidden rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-neutral-50/80"
							>
								<span
									className="absolute inset-y-1 left-0 rounded-md bg-accent-100/70 transition-[width] duration-500 ease-out group-hover:bg-accent-200/70"
									style={{ width: `${width}%` }}
									data-testid="toplist-bar"
									aria-hidden="true"
								/>
								<span
									className="relative z-10 truncate font-medium text-neutral-700"
									title={row.key}
								>
									{row.key}
								</span>
								<span className="relative z-10 shrink-0 font-semibold text-neutral-900 tabular-nums">
									{formatNumber(row.count)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</Card>
	);
}
