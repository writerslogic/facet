// Top events box: a ranked list of custom event names (not cross-filterable — events aren't a cube dim).
//
// Not drillable either: event name is not a filterable dimension in the API, so the expanded view
// explains that instead of offering a breakdown it would have to fabricate.
//
// Density: the list delegates all three tiers to `ListBody`. Compact draws its leader row — which
// event fires most and what share of the ranking it holds. Total event volume is the Events KPI's
// job, so this box never restates it, at any tier.

import { ChartEmpty } from '../charts/ChartChrome.js';
import { drillSpec } from './drill.js';
import { ListBody, rowsTable } from './shared.js';
import type { TileDef } from './types.js';

export const eventsListBox: TileDef = {
	table: (ctx) => rowsTable('Event', ctx.data.top_events),
	render: (ctx, density, config) => {
		const rows = ctx.data.top_events;
		if (rows.length === 0) {
			// IMPORTANT: a cube-only slice (device/country/channel) leaves `top_events` unsliced server
			// data, so only a path/referrer segment can empty this list; that is the one cause the copy
			// may name. Otherwise empty is ambiguous between a quiet window and a site that never called
			// facet.track, so both levers are offered and neither is asserted.
			const segmented =
				ctx.serverFilter.path !== undefined || ctx.serverFilter.referrer !== undefined;
			const lead = segmented ? 'No events in this segment' : 'No custom events';
			if (density === 'compact') {
				return (
					<p
						data-chrome
						className="flex h-full min-h-0 items-center justify-center px-2 text-center font-semibold text-[color:var(--muted)] text-xs"
					>
						{lead}
					</p>
				);
			}
			return (
				<ChartEmpty reason="empty" title={lead}>
					{segmented
						? 'Clear the segment or widen the date range to see events from the whole site.'
						: "Widen the date range, or call facet.track('signup') on the site if none are instrumented yet. Pageviews are counted without it."}
				</ChartEmpty>
			);
		}
		return (
			<ListBody
				title="Top events"
				rows={rows}
				density={density}
				config={config}
				compare={{ current: rows, select: (p) => p.top_events }}
				drill={drillSpec(ctx, null)}
				noun="Event name"
			/>
		);
	},
};
