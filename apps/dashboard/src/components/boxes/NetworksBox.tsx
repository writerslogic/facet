// Networks box: ranked list of visitor networks/ISPs (ASN org, edge-derived; k-anonymised). Enables
// cookieless B2B ("which organizations visited") — a dimension Umami cannot offer.
//
// Rows are EVENT counts over the top 12 organizations that clear the k-anonymity floor, so a share
// here is share-of-shown, never share-of-all-traffic. The cap bites harder here than on any other
// list: ASN org is an unbounded long tail, so the rows are a leaderboard, not an enumeration.
//
// Not drillable: network/ASN is not a filterable dimension in the API (see BrowsersBox).

import { drillSpec } from './drill.js';
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
	render: (ctx, density, config) => (
		<ListBody
			title="Networks"
			rows={ctx.data.top_networks ?? []}
			density={density}
			config={config}
			compare={{ current: ctx.data.top_networks ?? [], select: (p) => p.top_networks }}
			drill={drillSpec(ctx, null)}
			noun="Network"
		/>
	),
};
