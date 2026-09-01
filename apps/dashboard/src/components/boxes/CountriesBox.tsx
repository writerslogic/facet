// Countries box: an interactive prism choropleth world map, shaded by traffic; click a country to
// cross-filter the board.
//
// The map's shapes stay a pure volume encoding — a second colour scale for "up or down" across 175
// shapes would be unreadable. The period comparison rides in the two places the map states a NUMBER:
// the corner readout for the hovered country, and the top-five list beside it. As with the other cube
// dimensions the rows drawn are cube-derived while the comparison is the SERVER's country breakdown
// in both windows, so both sides of every percentage count the same thing (see ChannelsBox).
//
// A map has no rows, so it has nowhere to hang a per-row drill control — and the shapes themselves are
// already spoken for by the cross-filter. So the box now also offers the ranked-list styles every
// other dimension box has, and THOSE drill: pick Bars, Donut or Table in Customize and each country
// composes by device and channel straight from the cube. `map` is declared first so it remains the
// default and no existing board changes shape.

import type { CountRow } from '@facet/shared';
import type { ReactElement } from 'react';
import { type CompareSource, useBreakdownComparison } from '../../hooks/compare.js';
import { WorldMap } from '../WorldMap.js';
import { ChartEmpty } from '../charts/ChartChrome.js';
import { drillSpec } from './drill.js';
import { LIST_OPTIONS, ListBody, rowsTable } from './shared.js';
import type { TileContext, TileDef, TileVariant } from './types.js';

const MEASURE_NOTE = 'measured over all events for this country, not just the pageviews shown';

/** The cube folds every country outside its top 30 — and every unattributed hit — into `'other'`
 * (`cube()` in the server's db/stats). It is not a country: the choropleth has no shape for it, the
 * `top_countries` breakdown every comparison here reads never contains it, and the map's own top-five
 * hands its key back uppercased, so a click would filter the board to `OTHER` and match no cell at all. */
const CUBE_OTHER = 'other';

/** The board's country rows with the fold bucket dropped, so the map, the ranked lists, the deltas and
 * the table export all describe one population: ISO-coded countries. */
function countryRows(ctx: TileContext): CountRow[] {
	return ctx
		.dimRows('country', ctx.data.top_countries)
		.filter((r) => r.key.toLowerCase() !== CUBE_OTHER);
}

/** Map first (the shipped default), then the drillable ranked-list styles. */
const COUNTRY_VARIANTS: TileVariant[] = [
	{ id: 'map', label: 'Map' },
	{ id: 'bars', label: 'Bars' },
	{ id: 'donut', label: 'Donut' },
	{ id: 'table', label: 'Table' },
];

/** The map plus its per-country movements, read from the comparison the Overview already fetched. */
function ComparedWorldMap({
	rows,
	onSelect,
	activeKey,
	compare,
}: {
	rows: CountRow[];
	onSelect?: (key: string) => void;
	activeKey?: string;
	compare: CompareSource;
}): ReactElement {
	const { movements } = useBreakdownComparison(compare);
	return <WorldMap rows={rows} onSelect={onSelect} activeKey={activeKey} deltas={movements} />;
}

export const countriesBox: TileDef = {
	id: 'countries',
	title: 'Countries',
	size: 'lg',
	expandable: true,
	variants: COUNTRY_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Country', countryRows(ctx)),
	render: (ctx, density, config) => {
		const rows = countryRows(ctx);
		const compare: CompareSource = {
			current: ctx.data.top_countries ?? [],
			select: (p) => p.top_countries,
			note: MEASURE_NOTE,
		};
		if (rows.length === 0 && ctx.summary.pageviews > 0) {
			// IMPORTANT: not `reason="range"`. Every row here is ISO-coded, so a site whose traffic
			// carries no country at all empties this box while the window is fine — the range default
			// would name a cause the data does not support.
			const lead = ctx.anyFilter ? 'No countries in this segment' : 'No country data';
			if (density === 'compact') {
				return (
					<p className="flex h-full min-h-0 items-center justify-center px-2 text-center font-semibold text-[color:var(--muted)] text-xs">
						{lead}
					</p>
				);
			}
			return (
				<ChartEmpty reason="empty" title={lead}>
					{ctx.anyFilter
						? 'Clear the segment or widen the date range to see the whole site.'
						: 'Traffic in this range has no country attached to map.'}
				</ChartEmpty>
			);
		}
		// A choropleth needs area. Under 132px tall (a focused neighbour took the rows) or 232px wide
		// (the mobile grid), the map degrades to a smudge behind its own corner readout — so at compact
		// the map variant answers with the ranked list's leader row instead: the one geographic fact
		// that still fits, which country leads, by what share, moving which way.
		if (density === 'compact' || (config?.variant && config.variant !== 'map')) {
			return (
				<ListBody
					title="Countries"
					rows={rows}
					onSelect={ctx.dimSelect('country')}
					activeKey={ctx.cubeFilter.country}
					density={density}
					config={config}
					compare={compare}
					drill={drillSpec(ctx, 'country')}
				/>
			);
		}
		return (
			<ComparedWorldMap
				rows={rows}
				onSelect={ctx.dimSelect('country')}
				activeKey={ctx.cubeFilter.country}
				compare={compare}
			/>
		);
	},
};
