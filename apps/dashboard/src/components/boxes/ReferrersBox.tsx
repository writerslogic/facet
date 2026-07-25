// Referrers box: ranked list, click a referrer to cross-filter the board (server-side referrer filter).

import { ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const referrersBox: TileDef = {
	id: 'referrers',
	title: 'Referrers',
	size: 'lg',
	expandable: true,
	table: (ctx) => rowsTable('Referrer', ctx.data.top_referrers),
	render: (ctx, expanded) =>
		ListBody({
			title: 'Referrers',
			rows: ctx.data.top_referrers,
			onSelect: ctx.toggleServer('referrer'),
			activeKey: ctx.serverFilter.referrer,
			expanded,
		}),
};
