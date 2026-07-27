// Screen-size box: ranked list of viewport tiers (bucketed on-device by the tracker; k-anonymised).

import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const screensBox: TileDef = {
	id: 'screens',
	title: 'Screen size',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Screen', ctx.data.top_screens ?? []),
	render: (ctx, expanded, config) =>
		ListBody({
			title: 'Screen size',
			rows: ctx.data.top_screens ?? [],
			expanded,
			config,
		}),
};
