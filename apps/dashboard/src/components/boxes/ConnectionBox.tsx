// Connection box: ranked list of connection-quality tiers (fast/moderate/slow, from the edge TCP RTT;
// k-anonymised). A performance-segmentation dimension Umami cannot offer at all.

import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const connectionBox: TileDef = {
	id: 'connection',
	title: 'Connection',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Connection', ctx.data.top_connections ?? []),
	render: (ctx, expanded, config) =>
		ListBody({
			title: 'Connection',
			rows: ctx.data.top_connections ?? [],
			expanded,
			config,
		}),
};
