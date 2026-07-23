// Sankey flow diagram: renders an accessible SVG with a ribbon per link and a rect per placed node,
// and no-ops on empty input.

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sankey, type SankeyLink, type SankeyNode } from '../components/Sankey.js';

const NODES: SankeyNode[] = [
	{ id: 'a', label: 'A', column: 0 },
	{ id: 'b', label: 'B', column: 1 },
	{ id: 'c', label: 'C', column: 1 },
];
const LINKS: SankeyLink[] = [
	{ source: 'a', target: 'b', value: 3 },
	{ source: 'a', target: 'c', value: 1 },
];

describe('Sankey', () => {
	it('renders an svg with a ribbon per link and a node rect per node', () => {
		const { container } = render(<Sankey nodes={NODES} links={LINKS} />);
		const svg = container.querySelector('svg[role="img"]');
		expect(svg).not.toBeNull();
		expect(container.querySelectorAll('path')).toHaveLength(LINKS.length);
		expect(container.querySelectorAll('rect')).toHaveLength(NODES.length);
	});

	it('renders nothing without nodes or links', () => {
		const { container } = render(<Sankey nodes={[]} links={[]} />);
		expect(container.querySelector('svg')).toBeNull();
	});
});
