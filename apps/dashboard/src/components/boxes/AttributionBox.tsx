// Attribution box: revenue credited to channels under a chosen multi-touch model. The box's "chart
// style" variant IS the attribution model, so switching models is one click in Customize. Attribution
// is computed server-side over aggregate, day-scoped channel paths — no persistent cross-session id.

import type { AttributionModel } from '@facet/shared';
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
		return ListBody({
			title: 'Attribution',
			rows: modelRows(ctx, model),
			expanded,
			config,
		});
	},
};
