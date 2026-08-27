// The Explore panel is the dashboard's only reader of the columnar store, so the two properties
// worth pinning are the ones a plain render test would miss: that every dimension the API serves is
// actually reachable from the picker, and that a SAMPLED answer is never presented as a measurement.

import { BREAKDOWN_DIMENSIONS, type BreakdownResponse } from '@facet/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Explore, GROUPS, LABELS } from '../components/Explore.js';

const SITE = '11111111-1111-4111-8111-111111111111';

function body(source: BreakdownResponse['source'], sampled: boolean): BreakdownResponse {
	return {
		dimension: 'path',
		source,
		sampled,
		rows: [
			{ key: '/pricing', events: 90, pageviews: 80, visitors: 40 },
			{ key: '', events: 10, pageviews: 10, visitors: 5 },
		],
	};
}

function renderPanel(response: BreakdownResponse) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ ok: true, json: async () => response })),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<Explore apiKey="clk_x" siteId={SITE} range={{ start: 0, end: 1 }} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	window.history.replaceState(null, '', '/');
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Explore', () => {
	// A dimension added to BREAKDOWN_DIMENSIONS but left out of GROUPS is served by the API and
	// unreachable from the UI — a gap nothing else in the build would report.
	it('offers every dimension the breakdown endpoint serves, exactly once', () => {
		const offered = GROUPS.flatMap((g) => g.keys);
		expect([...offered].sort()).toEqual([...BREAKDOWN_DIMENSIONS].sort());
		expect(new Set(offered).size).toBe(offered.length);
		for (const key of BREAKDOWN_DIMENSIONS) expect(LABELS[key]).toBeTruthy();
	});

	it('names D1 as the source and calls the figures exact', async () => {
		renderPanel(body('d1', false));
		await waitFor(() => expect(screen.getByText(/D1 · exact/)).toBeInTheDocument());
		expect(screen.queryByText(/lower bound/)).not.toBeInTheDocument();
	});

	it('says a sampled columnar answer is an estimate, not a count', async () => {
		renderPanel(body('analytics_engine', true));
		await waitFor(() =>
			expect(screen.getByText(/Analytics Engine · sampled/)).toBeInTheDocument(),
		);
		expect(screen.getByText(/visitors is a lower bound/)).toBeInTheDocument();
	});

	// Both stores fold an absent dimension to the empty string. Rendered bare it is an empty cell
	// that reads as a rendering fault rather than as a real group with real counts.
	it('labels the absent-dimension group instead of rendering an empty cell', async () => {
		renderPanel(body('d1', false));
		await waitFor(() => expect(screen.getByText('(not set)')).toBeInTheDocument());
	});
});
