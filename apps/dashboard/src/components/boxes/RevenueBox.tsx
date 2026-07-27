// Revenue box: ecommerce totals (revenue, orders, AOV) from valued events; expands to revenue-by-channel.
// Revenue rides in event props (track('purchase', { revenue, currency })) and is summed server-side.

import type { ReactNode } from 'react';
import { formatNumber } from '../../lib/format.js';
import { ListBody } from './shared.js';
import type { TileDef } from './types.js';

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
function Stat({ label, value }: { label: string; value: string }): ReactNode {
	return (
		<div className="rounded-xl border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] p-3">
			<div className="font-semibold text-[10px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
				{label}
			</div>
			<div className="tabular mt-1 font-semibold text-2xl text-[color:var(--ink)]">
				{value}
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
						/>
						<Stat label="Orders" value={formatNumber(orders)} />
						<Stat label="AOV" value={orders > 0 && r ? money(r.aov, cur) : '—'} />
					</div>
					<div className="min-h-0 flex-1">
						{ListBody({
							title: 'Revenue by channel',
							rows: ctx.data.revenue_by_channel ?? [],
							expanded: true,
							config,
						})}
					</div>
				</div>
			);
		}
		return (
			<div className="flex h-full flex-col justify-center gap-1">
				<div className="font-semibold text-[11px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
					Revenue
				</div>
				<div className="tabular font-semibold text-3xl text-[color:var(--ink)] leading-none tracking-[-0.02em]">
					{r && r.total > 0 ? money(r.total, cur) : '—'}
				</div>
				<div className="mt-1 text-[color:var(--muted)] text-xs">
					{formatNumber(orders)} orders · {orders > 0 && r ? money(r.aov, cur) : '—'} AOV
				</div>
			</div>
		);
	},
};
