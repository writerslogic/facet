// Top pages box: ranked list, click a page to cross-filter the board (server-side path filter).

import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const pagesBox: TileDef = {
	id: 'pages',
	title: 'Top pages',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Page', ctx.data.top_paths),
	render: (ctx, expanded, config) =>
		ListBody({
			title: 'Top pages',
			rows: ctx.data.top_paths,
			onSelect: ctx.toggleServer('path'),
			activeKey: ctx.serverFilter.path,
			expanded,
			config,
		}),
};
