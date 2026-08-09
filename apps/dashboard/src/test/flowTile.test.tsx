// FlowTile owns the Sankey's interaction state: the base graph is channel -> device, and clicking a
// device node expands it to reveal its countries. This asserts that wiring end to end (the country
// column appears only after the click).

import type { CubeCell } from '@facet/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FlowTile } from '../components/FlowTile.js';

const CELLS: CubeCell[] = [
	{
		t: 0,
		device: 'mobile',
		country: 'US',
		channel: 'organic',
		pageviews: 5,
		events: 1,
		visitors: 3,
	},
	{
		t: 0,
		device: 'desktop',
		country: 'US',
		channel: 'direct',
		pageviews: 10,
		events: 0,
		visitors: 6,
	},
	{
		t: 0,
		device: 'mobile',
		country: 'GB',
		channel: 'organic',
		pageviews: 2,
		events: 0,
		visitors: 2,
	},
];

describe('FlowTile', () => {
	it('clicking a device node expands it to reveal its countries', async () => {
		render(<FlowTile cells={CELLS} />);
		// Base graph: channel -> device only, so no country label is present yet.
		expect(screen.queryByText('US')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Flow node mobile' }));
		// After expansion the country column (US, GB) appears (as a node label + its <title>).
		await waitFor(() => expect(screen.getAllByText('US').length).toBeGreaterThan(0));
		expect(screen.getAllByText('GB').length).toBeGreaterThan(0);
	});

	it('clears a stale isolation when its node disappears from a recomputed flow', () => {
		const { rerender } = render(<FlowTile cells={CELLS} />);
		// Isolate the "organic" channel node (not a device node, so this pins/unpins highlight).
		fireEvent.click(screen.getByRole('button', { name: 'Flow node organic' }));
		// Something else in the graph is now dimmed (unrelated to the isolated subgraph).
		expect(screen.getByRole('button', { name: 'Flow node direct' }).style.opacity).toBe('0.16');

		// New data (e.g. a range/segment change) with no "organic" channel at all — the isolated
		// node no longer exists in the recomputed flow.
		rerender(
			<FlowTile
				cells={[
					{
						t: 0,
						device: 'desktop',
						country: 'US',
						channel: 'direct',
						pageviews: 10,
						events: 0,
						visitors: 6,
					},
				]}
			/>,
		);

		// The stale isolation must not leave every remaining node dimmed.
		expect(screen.getByRole('button', { name: 'Flow node direct' }).style.opacity).toBe('1');
	});
});
