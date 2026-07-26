// Devices box: ranked list, click a device to cross-filter the board (client-side cube dim).

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
	render: (ctx, expanded, config) =>
		ListBody({
			title: 'Devices',
			rows: ctx.dimRows('device', ctx.data.top_devices),
			onSelect: ctx.dimSelect('device'),
			activeKey: ctx.cubeFilter.device,
			expanded,
			config,
		}),
};
