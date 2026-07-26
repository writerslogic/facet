// Channels box: ranked list, click a channel to cross-filter the board (client-side cube dim).

import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const channelsBox: TileDef = {
	id: 'channels',
	title: 'Channels',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Channel', ctx.dimRows('channel', ctx.data.channels)),
	render: (ctx, expanded, config) =>
		ListBody({
			title: 'Channels',
			rows: ctx.dimRows('channel', ctx.data.channels),
			onSelect: ctx.dimSelect('channel'),
			activeKey: ctx.cubeFilter.channel,
			expanded,
			config,
		}),
};
