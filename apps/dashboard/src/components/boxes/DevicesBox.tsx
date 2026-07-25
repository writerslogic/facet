// Devices box: ranked list, click a device to cross-filter the board (client-side cube dim).

import { ListBody } from './shared.js';
import type { TileDef } from './types.js';

export const devicesBox: TileDef = {
	id: 'devices',
	title: 'Devices',
	size: 'short',
	expandable: true,
	render: (ctx, expanded) =>
		ListBody({
			title: 'Devices',
			rows: ctx.dimRows('device', ctx.data.top_devices),
			onSelect: ctx.dimSelect('device'),
			activeKey: ctx.cubeFilter.device,
			expanded,
		}),
};
