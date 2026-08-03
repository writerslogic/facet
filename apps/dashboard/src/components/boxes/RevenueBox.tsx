// Revenue box: ecommerce totals (revenue, orders, AOV) from valued events; expands to revenue-by-channel.
// Revenue rides in event props (track('purchase', { revenue, currency })) and is summed server-side.

import type { StatsResponse } from '@facet/shared';
import type { ReactElement, ReactNode } from 'react';
import { usePreviousPeriodStats } from '../../hooks/compare.js';
import { countMovement, formatNumber } from '../../lib/format.js';
import { DeltaBadge } from '../Delta.js';
import { drillSpec } from './drill.js';
import { ListBody } from './shared.js';
import type { TileDef } from './types.js';

/**
 * Movement of one revenue figure against the equal-length preceding window. Reads the comparison the
 * Overview already fetched, so the tile costs no query of its own; when that window is unavailable
 * (or a segment is active, which the comparison does not honour) it renders nothing at all.
 */
function RevenueDelta({
	current,
	select,
}: {
	current: number;
	select: (previous: StatsResponse) => number | undefined;
}): ReactElement | null {
	const previous = usePreviousPeriodStats();
	return (
		<DeltaBadge
			movement={countMovement(current, previous ? select(previous) : null)}
			size="sm"
		/>
	);
}

/** Format a monetary amount in its currency, falling back to a plain number when currency is unknown. */
function money(value: number, currency: string | null): string {
	if (currency) {
		try {
			return new Intl.NumberFormat(undefined, {
				style: 'currency',
				currency,
				maximumFractionDigits: 0,
			}).format(value);
		} catch {
			// Unknown/invalid currency code — fall through to a plain number.
		}
	}
	return formatNumber(Math.round(value));
}

/** One stat card in the expanded revenue view. */
function Stat({
	label,
	value,
	delta,
}: {
	label: string;
	value: string;
	delta?: ReactNode;
}): ReactNode {
	return (
		<div className="rounded-xl border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] p-3">
			<div className="font-semibold text-[10px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
				{label}
			</div>
			<div className="tabular mt-1 flex items-baseline gap-1.5 font-semibold text-2xl text-[color:var(--ink)]">
				{value}
				{delta}
			</div>
		</div>
	);
}

export const revenueBox: TileDef = {
	id: 'revenue',
	title: 'Revenue',
	size: 'md',
	selfLabeled: true,
	emphasis: 'kpi',
	expandable: true,
	table: (ctx) => {
		const r = ctx.data.revenue;
		return {
			columns: ['Metric', 'Value'],
			rows: [
				['Revenue', r ? money(r.total, r.currency) : '—'],
				['Orders', r?.orders ?? 0],
				['AOV', r ? money(r.aov, r.currency) : '—'],
			],
		};
	},
	render: (ctx, expanded, config) => {
		const r = ctx.data.revenue;
		const cur = r?.currency ?? null;
		const orders = r?.orders ?? 0;
		if (expanded) {
			return (
				<div className="flex h-full flex-col gap-3">
					<div className="grid shrink-0 grid-cols-3 gap-3">
						<Stat
							label="Revenue"
							value={r && r.total > 0 ? money(r.total, cur) : '—'}
							delta={
								<RevenueDelta
									current={r?.total ?? 0}
									select={(p) => p.revenue?.total}
								/>
							}
						/>
						<Stat
							label="Orders"
							value={formatNumber(orders)}
							delta={
								<RevenueDelta current={orders} select={(p) => p.revenue?.orders} />
							}
						/>
						<Stat label="AOV" value={orders > 0 && r ? money(r.aov, cur) : '—'} />
					</div>
					<div className="min-h-0 flex-1">
						<ListBody
							title="Revenue by channel"
							rows={ctx.data.revenue_by_channel ?? []}
							expanded
							config={config}
							compare={{
								current: ctx.data.revenue_by_channel ?? [],
								select: (p) => p.revenue_by_channel,
							}}
							// Rows are channels, so each one composes from the cube. The panel's
							// own figures are pageviews/events/visitors and say so — a revenue
							// row and a traffic panel are two measures, never blended.
							drill={drillSpec(ctx, 'channel')}
						/>
					</div>
				</div>
			);
		}
		return (
			<div className="flex h-full flex-col justify-center gap-1">
				<div className="font-semibold text-[11px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
					Revenue
				</div>
				<div className="tabular flex items-baseline gap-2 font-semibold text-3xl text-[color:var(--ink)] leading-none tracking-[-0.02em]">
					{r && r.total > 0 ? money(r.total, cur) : '—'}
					<RevenueDelta current={r?.total ?? 0} select={(p) => p.revenue?.total} />
				</div>
				<div className="mt-1 text-[color:var(--muted)] text-xs">
					{formatNumber(orders)} orders · {orders > 0 && r ? money(r.aov, cur) : '—'} AOV
				</div>
			</div>
		);
	},
};
