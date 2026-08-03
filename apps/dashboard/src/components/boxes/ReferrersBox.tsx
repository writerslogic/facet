// Referrers box: ranked list, click a referrer to cross-filter the board (server-side referrer filter).
//
// Inspecting a row breaks that referrer down by page, channel, device and country. Referrer is not a
// cube axis, so the panel re-queries /api/stats with segment + drill path; only the panel waits.

import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const referrersBox: TileDef = {
	id: 'referrers',
	title: 'Referrers',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Referrer', ctx.data.top_referrers),
	render: (ctx, expanded, config) => (
		<ListBody
			title="Referrers"
			rows={ctx.data.top_referrers}
			onSelect={ctx.toggleServer('referrer')}
			activeKey={ctx.serverFilter.referrer}
			expanded={expanded}
			config={config}
			compare={{ current: ctx.data.top_referrers ?? [], select: (p) => p.top_referrers }}
			drill={drillSpec(ctx, 'referrer')}
		/>
	),
};
