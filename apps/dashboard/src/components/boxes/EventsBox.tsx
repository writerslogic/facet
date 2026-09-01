// Events KPI box: big number + prism columns; expands to a full chart + the top events.
//
// No drill on the contributors, deliberately: event NAME is not one of the five dimensions the
// stats API filters by, so there is nothing honest to compose an event out of. The Top events box
// carries that explanation where there is room to read it (see EventsListBox).

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
	render: (ctx, density, config) => (
		<KpiTile
			label="Events"
			value={ctx.summary.events}
			deltaPct={ctx.deltas.ev}
			deltaSense={ctx.sense(ctx.deltas.ev)}
			spark={ctx.sparks.ev}
			viz={(config?.variant as KpiVizName) ?? 'columns'}
			accent={accentOf(config)}
			density={density}
			breakdown={{
				title: 'Top events',
				rows: ctx.data.top_events,
				compare: { current: ctx.data.top_events ?? [], select: (p) => p.top_events },
			}}
		/>
	),
};
