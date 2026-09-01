// Attribution box: revenue credited to channels under a chosen multi-touch model. The box's "chart
// style" variant IS the attribution model, so switching models is one click in Customize. Attribution
// is computed server-side over aggregate, day-scoped channel paths — no persistent cross-session id.
//
// IMPORTANT: in AttributionResult a row's `count` carries the attributed REVENUE, not a tally, and the
// currency it is denominated in lives on the revenue rollup (`revenue.currency`), not on the row. Every
// figure this box draws or exports is money and is formatted, labelled or captioned as such.

import type { AttributionModel, CountRow } from '@facet/shared';
import type { ReactElement } from 'react';
import { useBreakdownComparison } from '../../hooks/compare.js';
import { uiLocale } from '../../lib/datetime.js';
import { formatNumber } from '../../lib/format.js';
import { DeltaBadge } from '../Delta.js';
import { ChartEmpty } from '../charts/ChartChrome.js';
import { drillSpec } from './drill.js';
import { LIST_OPTIONS, ListBody, accentOf } from './shared.js';
import type {
	TableData,
	TileConfig,
	TileContext,
	TileDef,
	TileDensity,
	TileVariant,
} from './types.js';

/** Selectable attribution models (the box's `variant`). Data-driven `markov` last. */
const MODELS: TileVariant[] = [
	{ id: 'last', label: 'Last touch' },
	{ id: 'first', label: 'First touch' },
	{ id: 'linear', label: 'Linear' },
	{ id: 'position', label: 'Position' },
	{ id: 'time_decay', label: 'Time decay' },
	{ id: 'markov', label: 'Markov' },
];

function modelOf(config: TileConfig | undefined): AttributionModel {
	return (config?.variant as AttributionModel) ?? 'last';
}

function modelLabel(model: AttributionModel): string {
	return MODELS.find((m) => m.id === model)?.label ?? model;
}

function modelRows(ctx: TileContext, model: AttributionModel): CountRow[] {
	return ctx.data.attribution?.models?.[model] ?? [];
}

function creditedTotal(rows: CountRow[]): number {
	let total = 0;
	for (const row of rows) total += row.count;
	return total;
}

/** A credit formatter for the site's dominant currency, built once per render because a list applies
 * it per row. No currency (no valued events, or a mixed-currency site the rollup could not resolve)
 * degrades to a plain number rather than asserting a unit nothing measured. */
function creditFormatter(currency: string | null): (value: number) => string {
	if (currency) {
		try {
			const fmt = new Intl.NumberFormat(uiLocale(), {
				style: 'currency',
				currency,
				maximumFractionDigits: 0,
			});
			return (value) => fmt.format(value);
		} catch {
			// Unknown/invalid currency code — fall through to a plain number.
		}
	}
	return formatNumber;
}

/**
 * The `compact` rendering: one row, bespoke rather than the shared `ListCompact` because "Attribution"
 * alone does not say last-touch or Markov, and the two routinely disagree about which channel leads.
 * The tag is also the first member to yield: channel and credit are the irreducible payload, so below
 * 15rem of tile body it drops out and the row is no wider than the shared one.
 */
function AttributionCompact({
	ctx,
	model,
	config,
}: {
	ctx: TileContext;
	model: AttributionModel;
	config?: TileConfig;
}): ReactElement {
	const rows = modelRows(ctx, model);
	const { movements } = useBreakdownComparison({
		current: rows,
		select: (p) => p.attribution?.models?.[model],
	});
	const top = rows[0];
	if (!top) return <ChartEmpty reason="range" compact />;

	const total = creditedTotal(rows);
	const share = total > 0 ? Math.round((top.count / total) * 100) : 0;
	const credit = creditFormatter(ctx.data.revenue?.currency ?? null);
	const accent = accentOf(config);

	return (
		<div className="flex h-full min-h-0 flex-col justify-center overflow-hidden">
			<div className="relative flex items-center gap-2 overflow-hidden rounded-md px-2 py-1.5">
				<span
					aria-hidden="true"
					className="absolute inset-y-0 left-0 rounded-md opacity-25"
					style={{ width: `${share}%`, background: accent ?? 'var(--d2)' }}
				/>
				<span className="relative shrink-0 font-semibold text-[10px] text-[color:var(--faint)] uppercase tracking-[0.06em] @max-[15rem]/tile:hidden">
					{modelLabel(model)}
				</span>
				<span className="relative min-w-0 truncate font-medium text-[color:var(--ink)] text-xs">
					{top.key}
				</span>
				<span className="relative ml-auto shrink-0 font-semibold text-[color:var(--ink)] text-sm tabular-nums">
					{credit(top.count)}
				</span>
				<span className="relative shrink-0 text-[10px] text-[color:var(--muted)] tabular-nums">
					{share}%
				</span>
				<DeltaBadge
					movement={movements.get(top.key)}
					size="sm"
					className="relative shrink-0"
				/>
			</div>
		</div>
	);
}

/** Which model produced these figures, and what they are denominated in. Nothing else on the tile
 * names either: the header is the box's name and the list draws bare numbers. Expanded has the room
 * to add the two totals the ranking is a share of. */
function caption(
	ctx: TileContext,
	model: AttributionModel,
	rows: CountRow[],
	density: TileDensity,
	credit: (value: number) => string,
): string {
	const currency = ctx.data.revenue?.currency ?? null;
	const name = modelLabel(model);
	if (density !== 'expanded') {
		return currency ? `${name} · credit in ${currency}` : `${name} · credited revenue`;
	}
	const conversions = ctx.data.attribution?.conversions ?? 0;
	const noun = conversions === 1 ? 'conversion' : 'conversions';
	return `${name} · ${formatNumber(conversions)} ${noun} · ${credit(creditedTotal(rows))} credited`;
}

function AttributionList({
	ctx,
	model,
	density,
	config,
}: {
	ctx: TileContext;
	model: AttributionModel;
	density: TileDensity;
	config?: TileConfig;
}): ReactElement {
	const rows = modelRows(ctx, model);
	const credit = creditFormatter(ctx.data.revenue?.currency ?? null);
	return (
		<div className="flex h-full min-h-0 flex-col gap-1.5">
			{rows.length > 0 ? (
				<p className="shrink-0 truncate text-[11px] text-[color:var(--muted)]">
					{caption(ctx, model, rows, density, credit)}
				</p>
			) : null}
			<div className="min-h-0 flex-1">
				<ListBody
					title="Attribution"
					rows={rows}
					density={density}
					config={config}
					format={credit}
					// Compared model-for-model: credit under this model in this window against credit
					// under the same model in the preceding one. Comparing across models would measure
					// the model choice, not the period.
					compare={{
						current: rows,
						select: (p) => p.attribution?.models?.[model],
					}}
					// The rows are channels, so the cube can compose them — but the panel measures
					// pageviews/events, not credited revenue, and labels every figure it draws.
					drill={drillSpec(ctx, 'channel')}
				/>
			</div>
		</div>
	);
}

export const attributionBox: TileDef = {
	id: 'attribution',
	title: 'Attribution',
	size: 'lg',
	expandable: true,
	variants: MODELS,
	options: LIST_OPTIONS,
	table: (ctx, config): TableData => {
		const model = modelOf(config);
		const rows = modelRows(ctx, model);
		const currency = ctx.data.revenue?.currency ?? null;
		const total = creditedTotal(rows);
		return {
			columns: [
				'Channel',
				`${modelLabel(model)} credit${currency ? ` (${currency})` : ''}`,
				'Share %',
			],
			rows: rows.map((r) => [
				r.key,
				r.count,
				total > 0 ? Math.round((r.count / total) * 100) : 0,
			]),
		};
	},
	render: (ctx, density, config) => {
		const model = modelOf(config);
		return density === 'compact' ? (
			<AttributionCompact ctx={ctx} model={model} config={config} />
		) : (
			<AttributionList ctx={ctx} model={model} density={density} config={config} />
		);
	},
};
