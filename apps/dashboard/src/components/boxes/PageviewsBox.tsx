// Pageviews KPI box: big number + a filled "horizon" skyline sparkline; expands to a full chart + the
// top pages that drove it (click a page to cross-filter the board).

import { KpiTile, type KpiVizName } from '../BentoTile.js';
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
	render: (ctx, expanded, config) => (
		<KpiTile
			label="Pageviews"
			value={ctx.summary.pageviews}
			deltaPct={ctx.deltas.pv}
			deltaSense={ctx.sense(ctx.deltas.pv)}
			spark={ctx.sparks.pv}
			viz={(config?.variant as KpiVizName) ?? 'horizon'}
			accent={accentOf(config)}
			expanded={expanded}
			breakdown={{
				title: 'Top pages',
				rows: ctx.data.top_paths,
				onSelect: ctx.toggleServer('path'),
				activeKey: ctx.serverFilter.path,
			}}
		/>
	),
};
