// Countries as a ranked proportional dot plot (not bars) — so it never reads like the Top Pages tile.
// Each row is a lane on a shared 0→max-share axis: a glowing dot sits at the country's traffic share,
// its radius tracks visitor volume, and the top three take the prism fills. Rows are click-to-cross-filter.

import type { CountRow } from '@facet/shared';
import { Check } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/cn.js';
import { formatNumber } from '../lib/format.js';

const PRISM = ['#818cf8', '#a78bfa', '#e879f9'] as const;
const MUTED = 'rgb(196 181 253 / 0.5)';

export function CountryDots({
	rows,
	onSelect,
	activeKey,
	limit = 6,
}: {
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	limit?: number;
}): ReactElement {
	const shown = rows.slice(0, limit);
	const total = rows.reduce((s, r) => s + r.count, 0);
	const max = shown.reduce((m, r) => Math.max(m, r.count), 0);
	const maxShare = total > 0 ? max / total : 1;
	if (shown.length === 0) {
		return <p className="py-6 text-center text-neutral-500 text-sm">No data yet</p>;
	}
	return (
		<ul className="flex h-full flex-col justify-center gap-0.5">
			{shown.map((row, i) => {
				const share = total > 0 ? row.count / total : 0;
				const pos = maxShare > 0 ? (share / maxShare) * 100 : 0;
				const r = 3 + (max > 0 ? row.count / max : 0) * 5;
				const color = i < 3 ? PRISM[i] : MUTED;
				const active = row.key === activeKey;
				const inner = (
					<>
						<span
							className="tabular w-4 shrink-0 text-right text-[11px] text-neutral-600"
							aria-hidden="true"
						>
							{i + 1}
						</span>
						<span
							className={cn(
								'w-7 shrink-0 font-medium font-mono text-[12px]',
								active ? 'text-accent-200' : 'text-neutral-200',
							)}
						>
							{row.key}
						</span>
						{/* The lane: a hairline axis with a glowing dot positioned by share. */}
						<span className="relative h-4 min-w-0 flex-1">
							<span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10" />
							<span
								className="-translate-y-1/2 absolute top-1/2 rounded-full"
								style={{
									left: `calc(${pos}% - ${r}px)`,
									width: `${r * 2}px`,
									height: `${r * 2}px`,
									background: color,
									boxShadow: `0 0 8px ${color}`,
								}}
							/>
						</span>
						<span className="flex shrink-0 items-baseline gap-1.5">
							<span className="text-[11px] text-neutral-500 tabular-nums">
								{total > 0 ? Math.round(share * 100) : 0}%
							</span>
							<span className="font-semibold text-neutral-50 text-sm tabular-nums">
								{formatNumber(row.count)}
							</span>
						</span>
					</>
				);
				const cls =
					'group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors';
				return (
					<li key={row.key}>
						{onSelect ? (
							<button
								type="button"
								aria-pressed={active}
								onClick={() => onSelect(row.key)}
								className={cn(
									cls,
									'hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40',
									active && 'bg-white/5 ring-1 ring-accent-400/40',
								)}
							>
								{active ? (
									<Check
										className="-ml-1 h-3 w-3 shrink-0 text-accent-300"
										aria-hidden="true"
									/>
								) : null}
								{inner}
							</button>
						) : (
							<div className={cls}>{inner}</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
