// Pageviews KPI box: big number + a filled "horizon" skyline sparkline; expands to a full chart + the
// top pages behind it (click a page to cross-filter the board).
//
// IMPORTANT: `top_paths` is COUNT(*) over every event on a path (db/stats.ts `topPaths`), so it is not
// a decomposition of `summary.pageviews` and its rows do not sum to the numeral above them. The
// measure note repeats that in each row delta's tooltip; nothing else on the tile says it.

import { KpiTile, type KpiVizName } from '../BentoTile.js';
import { drillSpec } from './drill.js';
import { ACCENT_OPTION, accentOf, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const pageviewsBox: TileDef = {
	id: 'pageviews',
	title: 'Pageviews',
	size: 'kpi',
	selfLabeled: true,
	emphasis: 'kpi',
	expandable: true,
	variants: [
		{ id: 'horizon', label: 'Horizon' },
		{ id: 'spark', label: 'Line' },
		{ id: 'columns', label: 'Columns' },
	],
	options: [ACCENT_OPTION],
	table: (ctx) => rowsTable('Page', ctx.data.top_paths),
	render: (ctx, density, config) => (
		<KpiTile
			label="Pageviews"
			value={ctx.summary.pageviews}
			deltaPct={ctx.deltas.pv}
			deltaSense={ctx.sense(ctx.deltas.pv)}
			spark={ctx.sparks.pv}
			viz={(config?.variant as KpiVizName) ?? 'horizon'}
			accent={accentOf(config)}
			density={density}
			breakdown={{
				title: 'Top pages',
				rows: ctx.data.top_paths,
				onSelect: ctx.toggleServer('path'),
				activeKey: ctx.serverFilter.path,
				compare: {
					current: ctx.data.top_paths ?? [],
					select: (p) => p.top_paths,
					note: 'counted over every event on this page, not just its pageviews',
				},
				drill: drillSpec(ctx, 'path'),
			}}
		/>
	),
};
