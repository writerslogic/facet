// Retention view: renders the cohort-retention triangle as a heatmap table, surfaces the server `note`
// (salt-window caveat) prominently, toggles period (weekly default / daily) with a refetch, and shows
// empty and error states via the shared StatusStates components.

import type { CohortRetentionResponse } from '@facet/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Retention } from '../components/Retention.js';

const SITE = '11111111-1111-4111-8111-111111111111';

interface Call {
	url: string;
}

let calls: Call[] = [];
let response: { ok: boolean; json: () => Promise<unknown> };

const WEEK_DATA: CohortRetentionResponse = {
	period: 'week',
	note: 'Retention is bounded by the daily salt window; cross-period retention is ~0 by design.',
	cohorts: [
		{ cohort: '2026-01-05', size: 120, retention: [1, 0.4, 0.2] },
		{ cohort: '2026-01-12', size: 80, retention: [1, 0.5] },
	],
};

function mockFetch() {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : String(input);
		calls.push({ url });
		return response;
	});
}

function renderView() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<Retention apiKey="clk_x" siteId={SITE} range={{ start: 0, end: 1 }} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	calls = [];
	response = { ok: true, json: async () => WEEK_DATA };
	vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Retention', () => {
	it('renders the triangle heatmap with cohort labels, sizes, and the note', async () => {
		renderView();
		await waitFor(() => expect(screen.getByText('2026-01-05')).toBeInTheDocument());
		expect(screen.getByText('2026-01-12')).toBeInTheDocument();
		// Cohort sizes are shown.
		expect(screen.getByText('120')).toBeInTheDocument();
		expect(screen.getByText('80')).toBeInTheDocument();
		// The salt-window note is surfaced.
		expect(screen.getByText(/bounded by the daily salt window/)).toBeInTheDocument();
		// A retained cell shows its percentage.
		expect(screen.getAllByText('40%').length).toBeGreaterThan(0);
		// Defaults to the weekly period.
		expect(calls.some((c) => c.url.includes('period=week'))).toBe(true);
	});

	it('toggles to the daily period and refetches', async () => {
		renderView();
		await waitFor(() => expect(screen.getByText('2026-01-05')).toBeInTheDocument());
		fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
		await waitFor(() => expect(calls.some((c) => c.url.includes('period=day'))).toBe(true));
	});

	it('shows the empty state when there are no cohorts', async () => {
		response = {
			ok: true,
			json: async () => ({
				period: 'week',
				cohorts: [],
				note: 'No cohorts.',
			}),
		};
		renderView();
		await waitFor(() =>
			expect(screen.getByText('No cohorts in this range')).toBeInTheDocument(),
		);
	});

	it('shows the error state on a non-auth failure', async () => {
		response = {
			ok: false,
			json: async () => ({ error: 'range_too_large' }),
		};
		renderView();
		await waitFor(() =>
			expect(screen.getByText('Could not load retention')).toBeInTheDocument(),
		);
	});
});
