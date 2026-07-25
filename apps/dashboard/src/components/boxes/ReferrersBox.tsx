// Referrers box: ranked list, click a referrer to cross-filter the board (server-side referrer filter).

import { ListBody } from './shared.js';
import type { TileDef } from './types.js';

export const referrersBox: TileDef = {
	id: 'referrers',
	title: 'Referrers',
	size: 'lg',
	expandable: true,
	render: (ctx, expanded) =>
		ListBody({
			title: 'Referrers',
			rows: ctx.data.top_referrers,
			onSelect: ctx.toggleServer('referrer'),
			activeKey: ctx.serverFilter.referrer,
			expanded,
		}),
};
