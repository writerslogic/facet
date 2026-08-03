// Browsers box: ranked list of visitor browser families (from UA client hints; k-anonymised server-side).
//
// Not drillable: browser is not a filterable dimension in the API, so the expanded view says so
// rather than showing a breakdown it cannot scope. Browser shares appear inside a page/referrer drill.

import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const browsersBox: TileDef = {
	id: 'browsers',
	title: 'Browsers',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Browser', ctx.data.top_browsers ?? []),
	render: (ctx, expanded, config) => (
		<ListBody
			title="Browsers"
			rows={ctx.data.top_browsers ?? []}
			expanded={expanded}
			config={config}
			compare={{ current: ctx.data.top_browsers ?? [], select: (p) => p.top_browsers }}
			drill={drillSpec(ctx, null)}
			noun="Browser"
		/>
	),
};
