// Traffic-flow box: the interactive Sankey (channel → device → country). Expanding fans every device
// open to its countries.

import { FlowTile } from '../FlowTile.js';
import type { TileDef } from './types.js';

export const flowBox: TileDef = {
	id: 'flow',
	title: 'Traffic flow',
	size: 'tall',
	emphasis: 'flow',
	expandable: true,
	render: (ctx, expanded) => <FlowTile cells={ctx.flowCells} dark expanded={expanded} />,
};
