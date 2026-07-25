// Events KPI box: big number + prism columns; expands to a full chart + the top events.

import { KpiTile } from '../BentoTile.js';
import { rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const eventsBox: TileDef = {
	id: 'events',
	title: 'Events',
	size: 'kpi',
	selfLabeled: true,
	emphasis: 'kpi',
	expandable: true,
	table: (ctx) => rowsTable('Event', ctx.data.top_events),
	render: (ctx, expanded) => (
		<KpiTile
			label="Events"
			value={ctx.summary.events}
			deltaPct={ctx.deltas.ev}
			deltaSense={ctx.sense(ctx.deltas.ev)}
			spark={ctx.sparks.ev}
			viz="columns"
			expanded={expanded}
			breakdown={{ title: 'Top events', rows: ctx.data.top_events }}
		/>
	),
};
