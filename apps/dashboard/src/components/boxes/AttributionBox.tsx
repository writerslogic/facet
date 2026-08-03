// Attribution box: revenue credited to channels under a chosen multi-touch model. The box's "chart
// style" variant IS the attribution model, so switching models is one click in Customize. Attribution
// is computed server-side over aggregate, day-scoped channel paths — no persistent cross-session id.

import type { AttributionModel } from '@facet/shared';
import { drillSpec } from './drill.js';
import { LIST_OPTIONS, ListBody, rowsTable } from './shared.js';
import type { TileDef, TileVariant } from './types.js';

/** Selectable attribution models (the box's `variant`). Data-driven `markov` last. */
const MODELS: TileVariant[] = [
	{ id: 'last', label: 'Last touch' },
	{ id: 'first', label: 'First touch' },
	{ id: 'linear', label: 'Linear' },
	{ id: 'position', label: 'Position' },
	{ id: 'time_decay', label: 'Time decay' },
	{ id: 'markov', label: 'Markov' },
];

function modelRows(
	ctx: Parameters<TileDef['render']>[0],
	model: AttributionModel,
): { key: string; count: number }[] {
	return ctx.data.attribution?.models?.[model] ?? [];
}

export const attributionBox: TileDef = {
	id: 'attribution',
	title: 'Attribution',
	size: 'lg',
	expandable: true,
	variants: MODELS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Channel', modelRows(ctx, 'last')),
	render: (ctx, expanded, config) => {
		const model = (config?.variant as AttributionModel) ?? 'last';
		return (
			<ListBody
				title="Attribution"
				rows={modelRows(ctx, model)}
				expanded={expanded}
				config={config}
				// Compared model-for-model: credit under `last` in this window against credit under
				// `last` in the preceding one. Comparing across models would measure the model choice,
				// not the period. Credit is currency, so the delta is a change in attributed revenue.
				compare={{
					current: modelRows(ctx, model),
					select: (p) => p.attribution?.models?.[model],
				}}
				// The rows are channels, so the cube can compose them — but the panel measures
				// pageviews/events, not credited revenue, and labels every figure it draws.
				drill={drillSpec(ctx, 'channel')}
			/>
		);
	},
};
