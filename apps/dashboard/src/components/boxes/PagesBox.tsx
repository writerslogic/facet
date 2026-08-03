// Top pages box: ranked list, click a page to cross-filter the board (server-side path filter).
//
// Inspecting a row asks the other question — what /pricing is MADE of. Path is not a cube axis, so
// that panel re-queries /api/stats with the whole scope (segment + drill path) and only the panel
// waits for it; the list keeps rendering throughout.

import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const pagesBox: TileDef = {
	id: 'pages',
	title: 'Top pages',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Page', ctx.data.top_paths),
	render: (ctx, expanded, config) => (
		<ListBody
			title="Top pages"
			rows={ctx.data.top_paths}
			onSelect={ctx.toggleServer('path')}
			activeKey={ctx.serverFilter.path}
			expanded={expanded}
			config={config}
			compare={{ current: ctx.data.top_paths ?? [], select: (p) => p.top_paths }}
			drill={drillSpec(ctx, 'path')}
		/>
	),
};
