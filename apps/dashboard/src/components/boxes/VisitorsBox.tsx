// Visitors KPI box: big number + a radial ratio gauge (visitors ÷ pageviews); expands to a full chart +
// the top countries that drove it.

import { KpiTile, type KpiVizName } from '../BentoTile.js';
import { drillSpec } from './drill.js';
import { ACCENT_OPTION, accentOf, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const visitorsBox: TileDef = {
	id: 'visitors',
	title: 'Visitors',
	size: 'kpi',
	selfLabeled: true,
	emphasis: 'kpi',
	expandable: true,
	variants: [
		{ id: 'gauge', label: 'Gauge' },
		{ id: 'spark', label: 'Line' },
		{ id: 'horizon', label: 'Horizon' },
		{ id: 'columns', label: 'Columns' },
	],
	options: [ACCENT_OPTION],
	table: (ctx) => rowsTable('Country', ctx.dimRows('country', ctx.data.top_countries)),
	render: (ctx, expanded, config) => (
		<KpiTile
			label="Visitors"
			value={ctx.summary.visitors}
			deltaPct={ctx.deltas.vis}
			deltaSense={ctx.sense(ctx.deltas.vis)}
			spark={ctx.sparks.vis}
			viz={(config?.variant as KpiVizName) ?? 'gauge'}
			accent={accentOf(config)}
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
				// Cube rows on screen, server rows on BOTH sides of the comparison (see ChannelsBox).
				compare: {
					current: ctx.data.top_countries ?? [],
					select: (p) => p.top_countries,
					note: 'measured over all events for this country, not just the pageviews shown',
				},
				drill: drillSpec(ctx, 'country'),
			}}
		/>
	),
};
