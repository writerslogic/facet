// Top-N breakdown list: Plausible-style horizontal bars where each bar width is proportional
// to the max count. Pure CSS/Tailwind, no chart lib.

import type { CountRow } from '@facet/shared';
import type { ReactElement } from 'react';

const numberFormat = new Intl.NumberFormat('en-US');

interface TopListProps {
	title: string;
	rows: CountRow[];
}

export function TopList({ title, rows }: TopListProps): ReactElement {
	const max = rows.reduce((acc, row) => Math.max(acc, row.count), 0);

	return (
		<section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
			<h3 className="mb-3 text-sm font-medium text-neutral-500">{title}</h3>
			{rows.length === 0 ? (
				<p className="py-6 text-center text-sm text-neutral-400">No data yet</p>
			) : (
				<ul className="space-y-1">
					{rows.map((row) => {
						const width = max > 0 ? (row.count / max) * 100 : 0;
						return (
							<li
								key={row.key}
								className="relative flex items-center justify-between overflow-hidden rounded-md px-2 py-1.5 text-sm"
							>
								<span
									className="absolute inset-y-0 left-0 rounded-md bg-sky-100"
									style={{ width: `${width}%` }}
									data-testid="toplist-bar"
									aria-hidden="true"
								/>
								<span className="relative z-10 truncate text-neutral-800">
									{row.key}
								</span>
								<span className="relative z-10 pl-3 font-medium text-neutral-600 tabular-nums">
									{numberFormat.format(row.count)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
