// Visitors KPI box: big number + a radial ratio gauge (visitors ÷ pageviews); expands to a full chart +
// the top countries that drove it.

import { KpiTile } from '../BentoTile.js';
import { rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const visitorsBox: TileDef = {
	id: 'visitors',
	title: 'Visitors',
	size: 'kpi',
	selfLabeled: true,
	emphasis: 'kpi',
	expandable: true,
	table: (ctx) => rowsTable('Country', ctx.dimRows('country', ctx.data.top_countries)),
	render: (ctx, expanded) => (
		<KpiTile
			label="Visitors"
			value={ctx.summary.visitors}
			deltaPct={ctx.deltas.vis}
			deltaSense={ctx.sense(ctx.deltas.vis)}
			spark={ctx.sparks.vis}
			viz="gauge"
			gaugeRatio={
				ctx.summary.pageviews > 0 ? ctx.summary.visitors / ctx.summary.pageviews : 0
			}
			gaugeLabel="of views"
			expanded={expanded}
			breakdown={{
				title: 'Top countries',
				rows: ctx.dimRows('country', ctx.data.top_countries),
				onSelect: ctx.dimSelect('country'),
				activeKey: ctx.cubeFilter.country,
			}}
		/>
	),
};
