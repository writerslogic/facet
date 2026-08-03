// Screen-size box: ranked list of viewport tiers (bucketed on-device by the tracker; k-anonymised).
//
// Not drillable: screen tier is not a filterable dimension in the API (see BrowsersBox).

import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const screensBox: TileDef = {
	id: 'screens',
	title: 'Screen size',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Screen', ctx.data.top_screens ?? []),
	render: (ctx, expanded, config) => (
		<ListBody
			title="Screen size"
			rows={ctx.data.top_screens ?? []}
			expanded={expanded}
			config={config}
			compare={{ current: ctx.data.top_screens ?? [], select: (p) => p.top_screens }}
			drill={drillSpec(ctx, null)}
			noun="Screen size"
		/>
	),
};
