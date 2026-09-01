// Traffic-flow box: the interactive Sankey (channel → device → country). Expanded fans every device
// open to its countries; compact drops the diagram for its leading route.

import { cubeFlow } from '../../lib/cube.js';
import { FlowTile } from '../FlowTile.js';
import { ListBody } from './shared.js';
import type { TileContext, TileDef } from './types.js';

interface Route {
	from: string;
	to: string;
	pageviews: number;
}

/** The base channel → device graph with node ids resolved to labels, ranked. One derivation shared by
 * the compact readout and the table export so the leading route on screen is the leading route copied. */
function routes(ctx: TileContext): Route[] {
	const flow = cubeFlow(ctx.flowCells, new Set());
	const label = new Map(flow.nodes.map((n) => [n.id, n.label]));
	const named = (id: string): string => label.get(id) ?? id;
	return flow.links
		.map((l) => ({ from: named(l.source), to: named(l.target), pageviews: l.value }))
		.sort((a, b) => b.pageviews - a.pageviews);
}

export const flowBox: TileDef = {
	id: 'flow',
	title: 'Traffic flow',
	size: 'tall',
	emphasis: 'flow',
	expandable: true,
	table: (ctx) => ({
		columns: ['From', 'To', 'Pageviews'],
		rows: routes(ctx).map((r) => [r.from, r.to, r.pageviews]),
	}),
	render: (ctx, density) =>
		density === 'compact' ? (
			// IMPORTANT: Sankey's labels are 11px inside a 728-unit-wide viewBox, so at the compact
			// threshold (232px) they render at 3.5px — a smear, not a diagram. Compact answers the
			// flow's one question as text: which route leads, by how much, how many others there are.
			// The 233-470px band is still a smear and still `default`; that needs a fix in Sankey.
			<ListBody
				title="Traffic flow"
				rows={routes(ctx).map((r) => ({ key: `${r.from} → ${r.to}`, count: r.pageviews }))}
				density="compact"
			/>
		) : (
			<FlowTile cells={ctx.flowCells} expanded={density === 'expanded'} />
		),
};
