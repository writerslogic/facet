// Retention view: the derived cohort math (weighted averages, confidence margin, sorting, best/worst
// ranking) plus the rendered page — curve by default, sortable triangle behind a toggle, the salt-window
// note dismissible-and-persisted, low-volume cohorts flagged and filterable, and the empty/error states.

import type { CohortRetentionResponse } from '@facet/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type CohortLike,
	Retention,
	hasReturnData,
	marginOfError,
	periodAverages,
	periodBase,
	rankCohorts,
	sortCohorts,
} from '../components/Retention.js';

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

/** The heatmap table, scoped so its cells don't collide with the same values in the summary strip. */
function triangle(): HTMLElement {
	return screen.getByRole('table', { name: /Cohort retention heatmap/ });
}

/** Render, wait for data, and switch to the triangle (the curve is the default view). */
async function renderTriangle() {
	const view = renderView();
	await waitFor(() => expect(screen.getByRole('button', { name: 'Triangle' })).toBeEnabled());
	fireEvent.click(screen.getByRole('button', { name: 'Triangle' }));
	await waitFor(() => expect(triangle()).toBeInTheDocument());
	return view;
}

beforeEach(() => {
	calls = [];
	response = { ok: true, json: async () => WEEK_DATA };
	localStorage.clear();
	vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('periodBase', () => {
	it('sums only the cohorts that have reached the column', () => {
		expect(periodBase(WEEK_DATA.cohorts, 1)).toBe(200);
		expect(periodBase(WEEK_DATA.cohorts, 2)).toBe(120);
		expect(periodBase(WEEK_DATA.cohorts, 5)).toBe(0);
	});
});

describe('marginOfError', () => {
	it('is null without a denominator', () => {
		expect(marginOfError(0.5, 0)).toBeNull();
	});

	it('shrinks as the cohort grows', () => {
		const small = marginOfError(0.5, 25) as number;
		const large = marginOfError(0.5, 2500) as number;
		expect(small).toBeCloseTo(0.196, 3);
		expect(large).toBeLessThan(small / 9);
	});

	it('is zero at the boundaries where there is no variance', () => {
		expect(marginOfError(0, 100)).toBe(0);
		expect(marginOfError(1, 100)).toBe(0);
	});
});

describe('hasReturnData', () => {
	it('ignores period 0, which is 1 for every cohort by definition', () => {
		expect(hasReturnData([{ retention: [1] }, { retention: [1] }])).toBe(false);
		expect(hasReturnData([{ retention: [1, 0] }])).toBe(false);
		expect(hasReturnData([{ retention: [1] }, { retention: [1, 0.02] }])).toBe(true);
	});
});

describe('sortCohorts', () => {
	const rows: CohortLike[] = [
		{ cohort: '2026-01-05', size: 120, retention: [1, 0.4, 0.2] },
		{ cohort: '2026-01-12', size: 80, retention: [1, 0.5] },
		{ cohort: '2026-01-19', size: 400, retention: [1] },
	];

	it('sorts by cohort label in both directions', () => {
		expect(sortCohorts(rows, { key: 'cohort', dir: 'asc' }).map((r) => r.cohort)).toEqual([
			'2026-01-05',
			'2026-01-12',
			'2026-01-19',
		]);
		expect(sortCohorts(rows, { key: 'cohort', dir: 'desc' })[0]?.cohort).toBe('2026-01-19');
	});

	it('sorts by size', () => {
		expect(sortCohorts(rows, { key: 'size', dir: 'desc' }).map((r) => r.size)).toEqual([
			400, 120, 80,
		]);
	});

	it('sinks cohorts that have not reached the column to the bottom in either direction', () => {
		expect(sortCohorts(rows, { key: 1, dir: 'desc' }).map((r) => r.cohort)).toEqual([
			'2026-01-12',
			'2026-01-05',
			'2026-01-19',
		]);
		expect(sortCohorts(rows, { key: 1, dir: 'asc' }).map((r) => r.cohort)).toEqual([
			'2026-01-05',
			'2026-01-12',
			'2026-01-19',
		]);
	});

	it('does not mutate the input', () => {
		const before = rows.map((r) => r.cohort);
		sortCohorts(rows, { key: 'size', dir: 'desc' });
		expect(rows.map((r) => r.cohort)).toEqual(before);
	});
});

describe('rankCohorts', () => {
	it('names the best and worst cohort at the period', () => {
		const ranked = rankCohorts(WEEK_DATA.cohorts, 1);
		expect(ranked?.best.cohort).toBe('2026-01-12');
		expect(ranked?.worst.cohort).toBe('2026-01-05');
	});

	it('ignores cohorts too small to trust', () => {
		const ranked = rankCohorts(
			[
				{ cohort: 'a', size: 5, retention: [1, 1] },
				{ cohort: 'b', size: 500, retention: [1, 0.3] },
				{ cohort: 'c', size: 500, retention: [1, 0.1] },
			],
			1,
		);
		expect(ranked?.best.cohort).toBe('b');
		expect(ranked?.worst.cohort).toBe('c');
	});

	it('returns null when there is nothing to compare', () => {
		expect(rankCohorts([{ cohort: 'a', size: 500, retention: [1, 0.3] }], 1)).toBeNull();
		// A flat tie has no best or worst.
		expect(
			rankCohorts(
				[
					{ cohort: 'a', size: 500, retention: [1, 0.3] },
					{ cohort: 'b', size: 500, retention: [1, 0.3] },
				],
				1,
			),
		).toBeNull();
		// Cohorts that have not reached the column are not rankable.
		expect(
			rankCohorts(
				[
					{ cohort: 'a', size: 500, retention: [1] },
					{ cohort: 'b', size: 500, retention: [1] },
				],
				1,
			),
		).toBeNull();
	});
});

describe('Retention', () => {
	it('opens on the curve with the weighted-average summary', async () => {
		renderView();
		await waitFor(() => expect(screen.getByText('Weighted average')).toBeInTheDocument());
		const summary = within(screen.getByRole('region', { name: 'Retention summary' }));
		// Weighted average at week 1: (0.4*120 + 0.5*80) / 200.
		expect(summary.getByText('44%')).toBeInTheDocument();
		expect(summary.getByText('200')).toBeInTheDocument();
		// The best/weakest cohorts are named, not left for the reader to find.
		expect(summary.getByText('50%')).toBeInTheDocument();
		expect(summary.getByText('2026-01-12')).toBeInTheDocument();
		// The decorative SVG has a screen-reader table standing in for it.
		expect(
			screen.getByRole('table', { name: /Weighted-average retention by week/ }),
		).toBeInTheDocument();
		// Defaults to the weekly period.
		expect(calls.some((c) => c.url.includes('period=week'))).toBe(true);
	});

	it('renders the triangle heatmap with cohort labels, sizes, and the note', async () => {
		await renderTriangle();
		const table = within(triangle());
		expect(table.getByText('2026-01-05')).toBeInTheDocument();
		expect(table.getByText('2026-01-12')).toBeInTheDocument();
		expect(table.getByText('120')).toBeInTheDocument();
		expect(table.getByText('80')).toBeInTheDocument();
		expect(screen.getByText(/bounded by the daily salt window/)).toBeInTheDocument();
		expect(table.getAllByText('40%').length).toBeGreaterThan(0);
	});

	it('toggles to the daily period and refetches', async () => {
		renderView();
		await waitFor(() => expect(screen.getByText('Weighted average')).toBeInTheDocument());
		fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
		await waitFor(() => expect(calls.some((c) => c.url.includes('period=day'))).toBe(true));
	});

	it('sorts the triangle by a period column and marks the sorted header', async () => {
		await renderTriangle();
		const rowLabels = (): string[] =>
			within(triangle())
				.getAllByRole('row')
				.slice(1, 3)
				.map((r) => within(r).getAllByRole('rowheader')[0]?.textContent ?? '');
		expect(rowLabels()[0]).toContain('2026-01-05');
		fireEvent.click(within(triangle()).getByRole('button', { name: 'Week 1' }));
		await waitFor(() => expect(rowLabels()[0]).toContain('2026-01-12'));
		expect(within(triangle()).getByRole('columnheader', { name: /Week 1/ })).toHaveAttribute(
			'aria-sort',
			'descending',
		);
	});

	it('badges the best and weakest cohort rows', async () => {
		await renderTriangle();
		const rows = within(triangle()).getAllByRole('rowheader');
		expect(rows.find((r) => r.textContent?.includes('best'))?.textContent).toContain(
			'2026-01-12',
		);
		expect(rows.find((r) => r.textContent?.includes('worst'))?.textContent).toContain(
			'2026-01-05',
		);
	});

	it('flags and can hide low-volume cohorts', async () => {
		response = {
			ok: true,
			json: async () => ({
				period: 'week',
				note: 'note',
				cohorts: [
					{ cohort: '2026-01-05', size: 400, retention: [1, 0.4] },
					{ cohort: '2026-01-12', size: 7, retention: [1, 1] },
				],
			}),
		};
		await renderTriangle();
		expect(screen.getByText('low n')).toBeInTheDocument();
		const hide = screen.getByRole('button', { name: /Hide cohorts under 30/ });
		fireEvent.click(hide);
		await waitFor(() => expect(screen.queryByText('2026-01-12')).not.toBeInTheDocument());
		expect(screen.getByText('2026-01-05')).toBeInTheDocument();
	});

	it('dismisses the salt-window note and remembers it', async () => {
		renderView();
		await waitFor(() =>
			expect(screen.getByText(/bounded by the daily salt window/)).toBeInTheDocument(),
		);
		fireEvent.click(screen.getByRole('button', { name: 'Dismiss the salt-window note' }));
		await waitFor(() =>
			expect(screen.queryByText(/bounded by the daily salt window/)).not.toBeInTheDocument(),
		);
		// It collapses to a reopen affordance rather than vanishing entirely.
		const reopen = screen.getByRole('button', { name: /Why is retention near zero/ });
		expect(localStorage.getItem('facet.retention.note-dismissed')).toBe('1');
		fireEvent.click(reopen);
		await waitFor(() =>
			expect(screen.getByText(/bounded by the daily salt window/)).toBeInTheDocument(),
		);
		expect(localStorage.getItem('facet.retention.note-dismissed')).toBeNull();
	});

	it('explains that a flat triangle is the salt window, not missing data', async () => {
		response = {
			ok: true,
			json: async () => ({
				period: 'week',
				note: 'note',
				cohorts: [
					{ cohort: '2026-01-05', size: 400, retention: [1] },
					{ cohort: '2026-01-12', size: 300, retention: [1] },
				],
			}),
		};
		renderView();
		await waitFor(() =>
			expect(screen.getByText(/Nothing to plot beyond week 0/)).toBeInTheDocument(),
		);
		expect(screen.getByText(/honest answer, not missing data/)).toBeInTheDocument();
	});

	it('shows the empty state, with the salt-window cause, when there are no cohorts', async () => {
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
		expect(screen.getByText(/visitor hashes rotate/)).toBeInTheDocument();
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

describe('periodAverages', () => {
	it('weights each cohort by its size', () => {
		expect(periodAverages(WEEK_DATA.cohorts, 3)[1]).toBeCloseTo(0.44);
		expect(periodAverages(WEEK_DATA.cohorts, 3)[2]).toBeCloseTo(0.2);
	});
});
