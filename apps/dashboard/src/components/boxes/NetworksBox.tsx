// Networks box: ranked list of visitor networks/ISPs (ASN org, edge-derived; k-anonymised). Enables
// cookieless B2B ("which organizations visited") — a dimension Umami cannot offer.

import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const networksBox: TileDef = {
	id: 'networks',
	title: 'Networks',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Network', ctx.data.top_networks ?? []),
	render: (ctx, expanded, config) =>
		ListBody({
			title: 'Networks',
			rows: ctx.data.top_networks ?? [],
			expanded,
			config,
		}),
};
