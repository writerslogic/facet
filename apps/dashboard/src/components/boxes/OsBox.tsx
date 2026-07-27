// Operating systems box: ranked list of visitor OS families (UA client hints; k-anonymised server-side).

import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const osBox: TileDef = {
	id: 'os',
	title: 'Operating systems',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('OS', ctx.data.top_os ?? []),
	render: (ctx, expanded, config) =>
		ListBody({
			title: 'Operating systems',
			rows: ctx.data.top_os ?? [],
			expanded,
			config,
		}),
};
