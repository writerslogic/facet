// Top events box: a ranked list of custom event names (not cross-filterable — events aren't a cube dim).

import { ListBody } from './shared.js';
import type { TileDef } from './types.js';

export const eventsListBox: TileDef = {
	id: 'events_list',
	title: 'Top events',
	size: 'lg',
	expandable: true,
	render: (ctx, expanded) =>
		ListBody({
			title: 'Top events',
			rows: ctx.data.top_events,
			expanded,
		}),
};
