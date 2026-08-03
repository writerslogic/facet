// Regions box: ranked list of sub-national regions (edge-derived from request.cf; k-anonymised so a
// sparsely-populated region never resolves to a near-unique visitor).
//
// Not drillable: region is not one of the five dimensions the stats API filters by, so there is no
// honest per-region composition to show. The expanded view says so rather than inventing one.

import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const regionsBox: TileDef = {
	id: 'regions',
	title: 'Regions',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Region', ctx.data.top_regions ?? []),
	render: (ctx, expanded, config) => (
		<ListBody
			title="Regions"
			rows={ctx.data.top_regions ?? []}
			expanded={expanded}
			config={config}
			compare={{ current: ctx.data.top_regions ?? [], select: (p) => p.top_regions }}
			drill={drillSpec(ctx, null)}
			noun="Region"
		/>
	),
};
