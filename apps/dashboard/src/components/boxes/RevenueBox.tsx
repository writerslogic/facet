// Revenue box: ecommerce totals (revenue, orders, AOV) from valued events; expands to revenue-by-channel.
// Revenue rides in event props (track('purchase', { revenue, currency })) and is summed server-side.
//
// Compact = the total on one line with orders/AOV trailing; default = that total as the hero numeral;
// expanded = the three figures as cards over the per-channel ranking.

import type { RevenueSummary } from '@facet/shared';
import type { ReactElement, ReactNode } from 'react';
import { usePreviousPeriodStats } from '../../hooks/compare.js';
import { uiLocale } from '../../lib/datetime.js';
import {
	COMPACT_ABOVE,
	type Movement,
	countMovement,
	exactHint,
	formatCompact,
	formatKpi,
	formatNumber,
} from '../../lib/format.js';
import { DeltaBadge } from '../Delta.js';
import { ChartEmpty } from '../charts/ChartChrome.js';
import { drillSpec } from './drill.js';
import { ListBody } from './shared.js';
import type { TileConfig, TileContext, TileDef, TileDensity } from './types.js';

const NO_REVENUE: RevenueSummary = { total: 0, orders: 0, aov: 0, currency: null };

/**
 * A formatter for the site's dominant currency. `options` unset lets the currency pick its own minor
 * units — AOV is the one figure here where that is the difference between $68.40 and $68. No currency
 * (a mixed-currency site the rollup could not resolve) degrades to a plain number rather than
 * asserting a unit nothing measured.
 */
function moneyFormatter(
	currency: string | null,
	options?: Intl.NumberFormatOptions,
): (value: number) => string {
	if (currency) {
		try {
			const fmt = new Intl.NumberFormat(uiLocale(), {
				style: 'currency',
				currency,
				...options,
			});
			return (value) => fmt.format(value);
		} catch {
			// Unknown/invalid currency code — fall through to a plain number.
		}
	}
	if (options?.notation === 'compact') return formatCompact;
	return (value) =>
		formatNumber(
			options?.maximumFractionDigits === 0 ? Math.round(value) : Number(value.toFixed(2)),
		);
}

/** The headline total. format.ts's COMPACT_ABOVE rule holds for money too, but `formatKpi` cannot
 * carry a currency, so the notation is set here and the exact figure rides in a title. Compact does
 * not shorten in every locale ("12,3 Mio. $"), so the caller still has to let this truncate. */
function heroTotal(
	total: number,
	currency: string | null,
	exact: (value: number) => string,
): { text: string; title?: string } {
	if (Math.abs(total) < COMPACT_ABOVE) return { text: exact(total) };
	return {
		text: moneyFormatter(currency, { notation: 'compact', maximumFractionDigits: 1 })(total),
		title: exact(total),
	};
}

interface RevenueMovements {
	total: Movement | null;
	orders: Movement | null;
	aov: Movement | null;
}

/**
 * Each figure against the equal-length preceding window, read from the comparison the Overview already
 * fetched — no query of its own, and nothing at all while a segment is active (that window is not
 * filtered to match). AOV is scaled to minor units first so `countMovement`'s low-volume guard sees a
 * real base rather than the number 68.
 */
function useRevenueMovements(r: RevenueSummary): RevenueMovements {
	const previous = usePreviousPeriodStats()?.revenue ?? null;
	return {
		total: countMovement(r.total, previous?.total),
		orders: countMovement(r.orders, previous?.orders),
		aov: countMovement(
			Math.round(r.aov * 100),
			previous ? Math.round(previous.aov * 100) : null,
		),
	};
}

/** One stat card in the expanded revenue view. */
function Stat({
	label,
	value,
	movement,
}: {
	label: string;
	value: string;
	movement: Movement | null;
}): ReactNode {
	return (
		<div className="rounded-xl border border-[color:rgb(var(--border))] bg-[color:rgb(var(--hover))] p-3">
			<div className="font-semibold text-[10px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
				{label}
			</div>
			<div className="tabular mt-1 flex items-baseline gap-1.5 font-semibold text-2xl text-[color:var(--ink)]">
				{value}
				<DeltaBadge movement={movement} size="sm" />
			</div>
		</div>
	);
}

/** What the per-channel ranking is denominated in, and why a channel may be missing from it: the
 * server withholds any channel below the order floor, and bare bars cannot say either. */
function channelCaption(currency: string | null): string {
	const unit = currency ? `Revenue in ${currency}` : 'Revenue per channel';
	return `${unit} · channels with too few orders are withheld`;
}

function RevenueBody({
	ctx,
	density,
	config,
}: {
	ctx: TileContext;
	density: TileDensity;
	config?: TileConfig;
}): ReactElement {
	const r = ctx.data.revenue ?? NO_REVENUE;
	const movements = useRevenueMovements(r);
	const money = moneyFormatter(r.currency, { maximumFractionDigits: 0 });
	const aov = moneyFormatter(r.currency);
	const hero = heroTotal(r.total, r.currency, money);

	if (r.orders === 0) {
		return (
			/* The tile is selfLabeled, so nothing else names it: the empty state has to say "revenue"
			   itself. The wrapper clips because ChartEmpty centres its own content, which overflows a
			   tile squeezed to 36px. */
			<div className="h-full min-h-0 overflow-hidden">
				<ChartEmpty
					reason="empty"
					title="No revenue in this range"
					compact={density === 'compact'}
				>
					Revenue rides on a purchase event's own revenue and currency props.
				</ChartEmpty>
			</div>
		);
	}

	const ordersLine = (
		<>
			<span title={exactHint(r.orders) ?? undefined}>{formatKpi(r.orders)}</span> orders ·{' '}
			{aov(r.aov)} AOV
		</>
	);

	if (density === 'compact') {
		return (
			<div className="flex h-full min-h-0 flex-col overflow-hidden">
				{/* my-auto, not justify-center: an auto margin collapses to zero when the box is
				    shorter than its content, so the total can never be centred off the top of a
				    tile squeezed to 36px by a focused neighbour. */}
				<div className="my-auto flex flex-col gap-1">
					<div className="flex items-baseline gap-2">
						<span className="min-w-0 truncate font-semibold text-[10px] text-[color:var(--muted)] uppercase leading-none tracking-[0.08em]">
							Revenue
						</span>
						<span
							title={hero.title}
							className="tabular ml-auto shrink-0 font-semibold text-[color:var(--ink)] text-base leading-none tracking-[-0.02em]"
						>
							{hero.text}
						</span>
						<DeltaBadge movement={movements.total} size="sm" className="shrink-0" />
					</div>
					<p className="truncate text-[10px] text-[color:var(--faint)] tabular-nums">
						{ordersLine}
					</p>
				</div>
			</div>
		);
	}

	if (density === 'default') {
		return (
			<div className="flex h-full min-h-0 flex-col overflow-hidden">
				<div className="my-auto flex flex-col gap-1">
					<div className="font-semibold text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[0.08em]">
						Revenue
					</div>
					<div className="tabular flex items-baseline gap-2 font-semibold text-3xl text-[color:var(--ink)] leading-none tracking-[-0.02em]">
						<span className="min-w-0 truncate" title={hero.title}>
							{hero.text}
						</span>
						<DeltaBadge movement={movements.total} size="sm" className="shrink-0" />
					</div>
					<p className="mt-1 truncate text-[color:var(--muted)] text-xs tabular-nums">
						{ordersLine}
					</p>
				</div>
			</div>
		);
	}

	const rows = ctx.data.revenue_by_channel ?? [];
	return (
		<div className="flex h-full flex-col gap-3">
			<div className="grid shrink-0 grid-cols-3 gap-3">
				<Stat label="Revenue" value={money(r.total)} movement={movements.total} />
				<Stat label="Orders" value={formatNumber(r.orders)} movement={movements.orders} />
				<Stat label="AOV" value={aov(r.aov)} movement={movements.aov} />
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-1.5">
				{rows.length > 0 ? (
					<p className="shrink-0 truncate text-[11px] text-[color:var(--muted)]">
						{channelCaption(r.currency)}
					</p>
				) : null}
				<div className="min-h-0 flex-1">
					<ListBody
						title="Revenue by channel"
						rows={rows}
						density="expanded"
						config={config}
						compare={{
							current: rows,
							select: (p) => p.revenue_by_channel,
						}}
						// Rows are channels, so each one composes from the cube. The panel's
						// own figures are pageviews/events/visitors and say so — a revenue
						// row and a traffic panel are two measures, never blended.
						drill={drillSpec(ctx, 'channel')}
					/>
				</div>
			</div>
		</div>
	);
}

export const revenueBox: TileDef = {
	// Machine-readable values, not the tile's own strings: this grid is copied as TSV into a
	// spreadsheet, where "$1,234" is text and not a number. The unit rides in the metric name, and a
	// metric this site never measured exports an empty cell: a zero there would claim a measurement.
	table: (ctx) => {
		const r = ctx.data.revenue;
		const unit = r?.currency ? ` (${r.currency})` : '';
		return {
			columns: ['Metric', 'Value'],
			rows: [
				[`Revenue${unit}`, r ? Number(r.total.toFixed(2)) : ''],
				['Orders', r ? r.orders : ''],
				[`AOV${unit}`, r ? Number(r.aov.toFixed(2)) : ''],
			],
		};
	},
	render: (ctx, density, config) => <RevenueBody ctx={ctx} density={density} config={config} />,
};
