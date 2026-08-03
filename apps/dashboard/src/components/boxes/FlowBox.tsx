// Traffic-flow box: the interactive Sankey (channel → device → country). Expanding fans every device
// open to its countries.

import { cubeFlow } from '../../lib/cube.js';
import { FlowTile } from '../FlowTile.js';
import type { TileDef } from './types.js';

export const flowBox: TileDef = {
	id: 'flow',
	title: 'Traffic flow',
	size: 'tall',
	emphasis: 'flow',
	expandable: true,
	table: (ctx) => {
		const flow = cubeFlow(ctx.flowCells, new Set());
		const label = new Map(flow.nodes.map((n) => [n.id, n.label]));
		return {
			columns: ['From', 'To', 'Value'],
			rows: flow.links.map((l) => [
				label.get(l.source) ?? l.source,
				label.get(l.target) ?? l.target,
				l.value,
			]),
		};
	},
	render: (ctx, expanded) => <FlowTile cells={ctx.flowCells} expanded={expanded} />,
};
