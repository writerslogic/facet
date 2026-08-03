// Devices box: ranked list, click a device to cross-filter the board (client-side cube dim).
//
// Rows are cube-derived (pageviews); the comparison is the server's device breakdown in BOTH windows,
// so both sides of every percentage count the same thing. See ChannelsBox for the full reasoning.
//
// Inspecting a row composes that device from the cube's other axes (country, channel) with no round
// trip at all — and reports visitors as an upper bound, because distinct counts do not sum across cells.

import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const devicesBox: TileDef = {
	id: 'devices',
	title: 'Devices',
	size: 'short',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Device', ctx.dimRows('device', ctx.data.top_devices)),
	render: (ctx, expanded, config) => (
		<ListBody
			title="Devices"
			rows={ctx.dimRows('device', ctx.data.top_devices)}
			onSelect={ctx.dimSelect('device')}
			activeKey={ctx.cubeFilter.device}
			expanded={expanded}
			config={config}
			compare={{
				current: ctx.data.top_devices ?? [],
				select: (p) => p.top_devices,
				note: 'measured over all events for this key, not just the pageviews shown',
			}}
			drill={drillSpec(ctx, 'device')}
		/>
	),
};
