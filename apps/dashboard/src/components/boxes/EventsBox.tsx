// Events KPI box: big number + prism columns; expands to a full chart + the top events.

import { KpiTile, type KpiVizName } from '../BentoTile.js';
import { ACCENT_OPTION, accentOf, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const eventsBox: TileDef = {
	id: 'events',
	title: 'Events',
	size: 'kpi',
	selfLabeled: true,
	emphasis: 'kpi',
	expandable: true,
	variants: [
		{ id: 'columns', label: 'Columns' },
		{ id: 'spark', label: 'Line' },
		{ id: 'horizon', label: 'Horizon' },
	],
	options: [ACCENT_OPTION],
	table: (ctx) => rowsTable('Event', ctx.data.top_events),
	render: (ctx, expanded, config) => (
		<KpiTile
			label="Events"
			value={ctx.summary.events}
			deltaPct={ctx.deltas.ev}
			deltaSense={ctx.sense(ctx.deltas.ev)}
			spark={ctx.sparks.ev}
			viz={(config?.variant as KpiVizName) ?? 'columns'}
			accent={accentOf(config)}
			expanded={expanded}
			breakdown={{ title: 'Top events', rows: ctx.data.top_events }}
		/>
	),
};
