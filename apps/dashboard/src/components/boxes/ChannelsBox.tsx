// Channels box: ranked list, click a channel to cross-filter the board (client-side cube dim).

import { ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const channelsBox: TileDef = {
	id: 'channels',
	title: 'Channels',
	size: 'lg',
	expandable: true,
	table: (ctx) => rowsTable('Channel', ctx.dimRows('channel', ctx.data.channels)),
	render: (ctx, expanded) =>
		ListBody({
			title: 'Channels',
			rows: ctx.dimRows('channel', ctx.data.channels),
			onSelect: ctx.dimSelect('channel'),
			activeKey: ctx.cubeFilter.channel,
			expanded,
		}),
};
