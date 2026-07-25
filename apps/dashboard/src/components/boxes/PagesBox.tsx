// Top pages box: ranked list, click a page to cross-filter the board (server-side path filter).

import { ListBody } from './shared.js';
import type { TileDef } from './types.js';

export const pagesBox: TileDef = {
	id: 'pages',
	title: 'Top pages',
	size: 'lg',
	expandable: true,
	render: (ctx, expanded) =>
		ListBody({
			title: 'Top pages',
			rows: ctx.data.top_paths,
			onSelect: ctx.toggleServer('path'),
			activeKey: ctx.serverFilter.path,
			expanded,
		}),
};
