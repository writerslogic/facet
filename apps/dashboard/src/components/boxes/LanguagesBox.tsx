// Languages box: ranked list of visitor primary languages (Accept-Language subtag; k-anonymised).

import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const languagesBox: TileDef = {
	id: 'languages',
	title: 'Languages',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Language', ctx.data.top_languages ?? []),
	render: (ctx, expanded, config) =>
		ListBody({
			title: 'Languages',
			rows: ctx.data.top_languages ?? [],
			expanded,
			config,
		}),
};
