// Top events box: a ranked list of custom event names (not cross-filterable — events aren't a cube dim).
//
// Not drillable either: event name is not a filterable dimension in the API, so the expanded view
// explains that instead of offering a breakdown it would have to fabricate.

import { drillSpec } from './drill.js';
import { LIST_OPTIONS, LIST_VARIANTS, ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const eventsListBox: TileDef = {
	id: 'events_list',
	title: 'Top events',
	size: 'lg',
	expandable: true,
	variants: LIST_VARIANTS,
	options: LIST_OPTIONS,
	table: (ctx) => rowsTable('Event', ctx.data.top_events),
	render: (ctx, expanded, config) => (
		<ListBody
			title="Top events"
			rows={ctx.data.top_events}
			expanded={expanded}
			config={config}
			compare={{ current: ctx.data.top_events ?? [], select: (p) => p.top_events }}
			drill={drillSpec(ctx, null)}
			noun="Event name"
		/>
	),
};
