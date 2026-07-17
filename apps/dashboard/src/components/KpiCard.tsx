// A single KPI card: label, big tabular value, an optional period-over-period delta shown with an
// arrow icon + text (never color alone), and an optional sparkline.

import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { type Delta, formatDeltaPct } from '../lib/format.js';
import { Sparkline } from './Sparkline.js';

function DeltaBadge({ delta }: { delta: Delta }): ReactElement {
	const rose = delta.absolute > 0;
	const flat = delta.absolute === 0;
	const Icon = flat ? Minus : rose ? ArrowUpRight : ArrowDownRight;

	const tone =
		delta.sense === 'improvement'
			? 'text-emerald-700'
			: delta.sense === 'regression'
				? 'text-rose-700'
				: 'text-neutral-500';

	const senseLabel =
		delta.sense === 'improvement'
			? 'improved'
			: delta.sense === 'regression'
				? 'worsened'
				: 'changed';

	return (
		<span
			className={cn('inline-flex items-center gap-1 text-xs font-medium tabular-nums', tone)}
			title={`${senseLabel} vs previous period`}
		>
			<Icon className="h-3.5 w-3.5" aria-hidden="true" />
			<span>{formatDeltaPct(delta)}</span>
			<span className="sr-only"> {senseLabel} versus previous period</span>
		</span>
	);
}

export function KpiCard({
	label,
	value,
	delta,
	sparkline,
	sparklineStroke,
	hint,
}: {
	label: string;
	value: ReactNode;
	delta?: Delta | null;
	sparkline?: number[];
	sparklineStroke?: string;
	hint?: string;
}): ReactElement {
	return (
		<div className="flex flex-col justify-between rounded-2xl border border-neutral-200/80 bg-white p-5 shadow-sm ring-1 ring-neutral-900/[0.02] transition-shadow hover:shadow-md">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-[13px] font-medium text-neutral-500" title={hint}>
						{label}
					</div>
					<div className="mt-1.5 text-3xl font-semibold tracking-tight text-neutral-900 tabular-nums">
						{value}
					</div>
				</div>
				{sparkline && sparkline.length > 1 ? (
					<Sparkline values={sparkline} stroke={sparklineStroke} />
				) : null}
			</div>
			{delta ? (
				<div className="mt-3">
					<DeltaBadge delta={delta} />
				</div>
			) : null}
		</div>
	);
}
