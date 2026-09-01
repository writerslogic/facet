// Visitors KPI box: big number + a radial ratio gauge (visitors ÷ pageviews); expands to a full chart +
// the top countries that drove it.
//
// IMPORTANT: the contributor rows are a different measure from the numeral above them — the cube's
// per-country pageviews, or the server's per-country event counts when there is no cube or a
// path/referrer segment forces server mode (see `dimRows` in App.tsx). Never distinct visitors, so
// they neither sum to nor decompose the figure.

import type { CountRow } from '@facet/shared';
import { KpiTile, type KpiVizName } from '../BentoTile.js';
import { drillSpec } from './drill.js';
import { ACCENT_OPTION, accentOf, rowsTable } from './shared.js';
import type { TileContext, TileDef } from './types.js';

/** The cube folds every country outside its top 30 — and every unattributed hit — into `'other'`
 * (`cube()` in the server's db/stats). It is not a country: `top_countries` (both comparison windows)
 * never contains it, so it can never carry a delta, and a drill that routes to the stats API asks for
 * `country='other'` and matches nothing. Dropped so rows, deltas and the export share one population. */
const CUBE_OTHER = 'other';

function countryRows(ctx: TileContext): CountRow[] {
	return ctx
		.dimRows('country', ctx.data.top_countries)
		.filter((r) => r.key.toLowerCase() !== CUBE_OTHER);
}

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
	table: (ctx) => rowsTable('Country', countryRows(ctx)),
	render: (ctx, density, config) => (
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
			density={density}
			breakdown={{
				title: 'Top countries',
				rows: countryRows(ctx),
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
