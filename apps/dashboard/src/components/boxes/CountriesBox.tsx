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
import { drillSpec } from './drill.js';
import { LIST_OPTIONS, ListBody, rowsTable } from './shared.js';
import type { TileDef, TileVariant } from './types.js';

const MEASURE_NOTE = 'measured over all events for this country, not just the pageviews shown';

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
	table: (ctx) => rowsTable('Country', ctx.dimRows('country', ctx.data.top_countries)),
	render: (ctx, expanded, config) => {
		const rows = ctx.dimRows('country', ctx.data.top_countries);
		const compare: CompareSource = {
			current: ctx.data.top_countries ?? [],
			select: (p) => p.top_countries,
			note: MEASURE_NOTE,
		};
		if (config?.variant && config.variant !== 'map') {
			return (
				<ListBody
					title="Countries"
					rows={rows}
					onSelect={ctx.dimSelect('country')}
					activeKey={ctx.cubeFilter.country}
					expanded={expanded}
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
