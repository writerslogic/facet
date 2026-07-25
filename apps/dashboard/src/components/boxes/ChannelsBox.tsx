// Channels box: ranked list, click a channel to cross-filter the board (client-side cube dim).

import { ListBody } from './shared.js';
import type { TileDef } from './types.js';

export const channelsBox: TileDef = {
	id: 'channels',
	title: 'Channels',
	size: 'lg',
	expandable: true,
	render: (ctx, expanded) =>
		ListBody({
			title: 'Channels',
			rows: ctx.dimRows('channel', ctx.data.channels),
			onSelect: ctx.dimSelect('channel'),
			activeKey: ctx.cubeFilter.channel,
			expanded,
		}),
};
