// Channels box: ranked list, click a channel to cross-filter the board (client-side cube dim).
//
// The rows drawn here come from the in-memory cube (pageviews per cell); the comparison is the
// SERVER's channel breakdown in BOTH windows — never cube-against-server, which would divide one
// measure by another and call the result a trend. The two measures differ (the server counts
// SESSIONS per channel, the cube counts pageviews), so each badge says so via `note`.
//
// Inspecting a row composes that channel from the cube's other axes (device, country) client-side.

import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const channelsBox: TileDef = {
	id: 'channels',
	title: 'Channels',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Channel', ctx.dimRows('channel', ctx.data.channels)),
	render: (ctx, density, config) => (
		<ListBody
			title="Channels"
			rows={ctx.dimRows('channel', ctx.data.channels)}
			onSelect={ctx.dimSelect('channel')}
			activeKey={ctx.cubeFilter.channel}
			density={density}
			config={config}
			compare={{
				current: ctx.data.channels ?? [],
				select: (p) => p.channels,
				note: 'counted as sessions for this channel, not the pageviews shown',
			}}
			drill={drillSpec(ctx, 'channel')}
		/>
	),
};
