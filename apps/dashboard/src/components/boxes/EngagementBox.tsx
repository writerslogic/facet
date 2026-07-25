// Engagement box: sessions, bounce rate, pages/session, avg duration. Compact = a stat list; expanded =
// a stat-card grid + a bounce-rate bar.

import type { ReactNode } from 'react';
import { formatDuration, formatPercent } from '../../lib/format.js';
import type { TileDef } from './types.js';

/** A tiny stat row for the compact engagement view. */
function Stat({ label, value }: { label: string; value: string }): ReactNode {
	return (
		<div className="flex items-baseline justify-between gap-2 border-[color:rgb(var(--border))] border-b py-2 last:border-0">
			<span className="text-[color:var(--muted)] text-xs">{label}</span>
			<span className="tabular font-semibold text-[color:var(--ink)] text-sm">{value}</span>
		</div>
	);
}

export const engagementBox: TileDef = {
	id: 'engagement',
	title: 'Engagement',
	size: 'md',
	expandable: true,
	render: (ctx, expanded) => {
		const e = ctx.engagement;
		const cells = [
			{ label: 'Sessions', value: e.sessions.toLocaleString() },
			{ label: 'Bounce rate', value: formatPercent(e.bounce_rate) },
			{ label: 'Pages / session', value: e.pages_per_session.toFixed(1) },
			{
				label: 'Avg. duration',
				value: formatDuration(e.avg_duration_ms),
			},
		];
		if (expanded) {
			return (
				<div className="flex h-full flex-col gap-3">
					<div className="grid grid-cols-2 gap-3">
						{cells.map((c) => (
							<div
								key={c.label}
								className="rounded-xl border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] p-3"
							>
								<div className="text-[10px] font-semibold text-[color:var(--muted)] uppercase tracking-[0.08em]">
									{c.label}
								</div>
								<div className="tabular mt-1 font-semibold text-2xl text-[color:var(--ink)]">
									{c.value}
								</div>
							</div>
						))}
					</div>
					<div className="mt-auto">
						<div className="mb-1 flex justify-between text-[11px] text-[color:var(--muted)]">
							<span>Bounce rate</span>
							<span className="tabular">{formatPercent(e.bounce_rate)}</span>
						</div>
						<div className="h-2 w-full overflow-hidden rounded-full bg-[color:rgb(var(--hover))]">
							<div
								className="h-full rounded-full bg-[var(--d1)]"
								style={{
									width: `${Math.min(100, Math.round(e.bounce_rate * 100))}%`,
								}}
							/>
						</div>
					</div>
				</div>
			);
		}
		return (
			<div className="flex h-full flex-col justify-center">
				{cells.map((c) => (
					<Stat key={c.label} label={c.label} value={c.value} />
				))}
			</div>
		);
	},
};
