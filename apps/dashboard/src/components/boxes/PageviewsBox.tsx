// Pageviews KPI box: big number + a filled "horizon" skyline sparkline; expands to a full chart + the
// top pages that drove it (click a page to cross-filter the board).

import { KpiTile } from '../BentoTile.js';
import { rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const pageviewsBox: TileDef = {
	id: 'pageviews',
	title: 'Pageviews',
	size: 'kpi',
	selfLabeled: true,
	emphasis: 'kpi',
	expandable: true,
	table: (ctx) => rowsTable('Page', ctx.data.top_paths),
	render: (ctx, expanded) => (
		<KpiTile
			label="Pageviews"
			value={ctx.summary.pageviews}
			deltaPct={ctx.deltas.pv}
			deltaSense={ctx.sense(ctx.deltas.pv)}
			spark={ctx.sparks.pv}
			viz="horizon"
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
