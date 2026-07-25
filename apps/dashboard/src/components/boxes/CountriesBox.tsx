// Countries box: an interactive prism choropleth world map, shaded by traffic; click a country to
// cross-filter the board.

import { WorldMap } from '../WorldMap.js';
import type { TileDef } from './types.js';

export const countriesBox: TileDef = {
	id: 'countries',
	title: 'Countries',
	size: 'lg',
	expandable: true,
	render: (ctx) => (
		<WorldMap
			rows={ctx.dimRows('country', ctx.data.top_countries)}
			onSelect={ctx.dimSelect('country')}
			activeKey={ctx.cubeFilter.country}
		/>
	),
};
