// Browsers box: ranked list of visitor browser families (from UA client hints; k-anonymised server-side).

import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const browsersBox: TileDef = {
	id: 'browsers',
	title: 'Browsers',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Browser', ctx.data.top_browsers ?? []),
	render: (ctx, expanded, config) =>
		ListBody({
			title: 'Browsers',
			rows: ctx.data.top_browsers ?? [],
			expanded,
			config,
		}),
};
