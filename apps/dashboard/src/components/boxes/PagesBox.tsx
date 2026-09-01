// Top pages box: ranked list, click a page to cross-filter the board (server-side path filter).
//
// Inspecting a row asks the other question — what /pricing is MADE of. Path is not a cube axis, so
// that panel re-queries /api/stats with the whole scope (segment + drill path) and only the panel
// waits for it; the list keeps rendering throughout.
//
// Density: all three tiers delegate to `ListBody`. Compact draws the leader row and its share of
// the rows shown, the only honest denominator here. `topPaths` is COUNT(*) per path with no
// event-kind predicate (apps/server/src/db/stats.ts), so a row counts pageviews AND custom events
// fired on that page, while `ctx.data.summary.pageviews` counts `name IS NULL` rows only and
// `ctx.summary` is cube sliced besides. A share against either divides two populations, and against
// `data.summary.pageviews` it can exceed 100%.

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
	render: (ctx, density, config) => (
		<ListBody
			title="Top pages"
			rows={ctx.data.top_paths}
			onSelect={ctx.toggleServer('path')}
			activeKey={ctx.serverFilter.path}
			density={density}
			config={config}
			compare={{ current: ctx.data.top_paths ?? [], select: (p) => p.top_paths }}
			drill={drillSpec(ctx, 'path')}
		/>
	),
};
