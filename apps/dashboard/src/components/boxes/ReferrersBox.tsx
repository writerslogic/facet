// Referrers box: ranked list, click a referrer to cross-filter the board (server-side referrer filter).
//
// Inspecting a row breaks that referrer down by page, channel, device and country. Referrer is not a
// cube axis, so the panel re-queries /api/stats with segment + drill path; only the panel waits.
//
// Density: all three tiers come from `ListBody`. Compact draws its leader row, which source sends the
// most traffic, what share of the referred total it holds and which way it moved. That is the whole
// question a referrer ranking answers, so drawing only it loses nothing.

import { ChartEmpty } from '../charts/ChartChrome.js';
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
	render: (ctx, density, config) => {
		const rows = ctx.data.top_referrers;
		// IMPORTANT: `topReferrers` excludes the empty referrer, so direct traffic is never a row here.
		// An empty list over a range that HAD traffic is a fact about the traffic, not the absence
		// "nothing in this range" would claim. Read from `data.summary`, which is scoped to the same
		// query as these rows; `ctx.summary` follows a client-side cube slice that the server's
		// referrer breakdown does not.
		if (rows.length === 0 && ctx.data.summary.visitors > 0) {
			return (
				<ChartEmpty
					reason="empty"
					title="All traffic arrived direct"
					compact={density === 'compact'}
				>
					No visit in this range carried a referrer: they arrived typed, bookmarked, or
					from an app that strips it. Channels counts those as direct.
				</ChartEmpty>
			);
		}
		return (
			<ListBody
				title="Referrers"
				rows={rows}
				onSelect={ctx.toggleServer('referrer')}
				activeKey={ctx.serverFilter.referrer}
				density={density}
				config={config}
				compare={{ current: rows, select: (p) => p.top_referrers }}
				drill={drillSpec(ctx, 'referrer')}
			/>
		);
	},
};
