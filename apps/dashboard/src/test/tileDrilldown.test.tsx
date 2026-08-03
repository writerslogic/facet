// In-tile drill-down: a row can reveal what it is MADE of, without disturbing the board.
//
// The cases here pin the three things that make this honest rather than merely interactive:
//   1. inspecting is not filtering — the panel opens and the global segment is untouched;
//   2. a drill COMPOSES with an active segment (`segment ∪ drill path`), and picks its transport from
//      that union — the cube when it can answer, /api/stats when the scope names a path/referrer;
//   3. visitors is reported as an upper bound exactly when it is one, and as a count when it is not.
//
// The numbers below are computed by hand from CELLS so a regression in the slicing shows up as a wrong
// figure rather than as a passing test over whatever the code happens to produce.

import type { CubeCell, StatsResponse } from '@facet/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrillSpec } from '../components/boxes/drill.js';
import { ListBody } from '../components/boxes/shared.js';
import { DashboardProvider } from '../state.js';

const SITE = '11111111-1111-4111-8111-111111111111';

const statsMock = vi.fn();

// Mocked wholesale so no case here opens a real request: `useCompareStats` is what the shared compare
// hook reads (returning nothing ⇒ no deltas, which keeps these assertions about the drill), and
// `useStats` is the one the server-side panel calls, so the case below can read the query it built.
vi.mock('../hooks/stats.js', () => ({
	useStats: (...args: unknown[]) => statsMock(...args),
	useCompareStats: () => ({ data: undefined }),
	useFreshness: () => ({ data: null }),
}));

/**
 * Four cells over two buckets. Country US spans three of them (and TWO of them share bucket t=1),
 * which is precisely the shape that makes a summed visitor count an over-count; country DE sits alone
 * in its bucket, so a DE slice is exact.
 */
const CELLS: CubeCell[] = [
	{
		t: 1,
		device: 'desktop',
		country: 'US',
		channel: 'direct',
		pageviews: 100,
		events: 10,
		visitors: 40,
	},
	{
		t: 1,
		device: 'mobile',
		country: 'US',
		channel: 'social',
		pageviews: 60,
		events: 6,
		visitors: 25,
	},
	{
		t: 2,
		device: 'desktop',
		country: 'DE',
		channel: 'direct',
		pageviews: 30,
		events: 3,
		visitors: 12,
	},
	{
		t: 2,
		device: 'mobile',
		country: 'US',
		channel: 'direct',
		pageviews: 20,
		events: 2,
		visitors: 9,
	},
];

const COUNTRY_ROWS = [
	{ key: 'US', count: 180 },
	{ key: 'DE', count: 30 },
];

function spec(overrides: Partial<DrillSpec> = {}): DrillSpec {
	return {
		axis: 'country',
		cells: CELLS,
		cubeFilter: {},
		serverFilter: {},
		...overrides,
	};
}

function wrap(node: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<DashboardProvider>{node}</DashboardProvider>
		</QueryClientProvider>,
	);
}

/** The inspect control for a row ("Break down US by other dimensions"). */
function inspectControl(key: string): HTMLElement {
	return screen.getByRole('button', { name: `Break down ${key} by other dimensions` });
}

/** The open composition panel. */
function panel(): HTMLElement {
	return screen.getByRole('region', { name: /breakdown$/ });
}

beforeEach(() => {
	statsMock.mockReset();
	statsMock.mockReturnValue({
		data: undefined,
		error: null,
		isPending: true,
		isPlaceholderData: false,
	});
	localStorage.clear();
	localStorage.setItem(
		'facet.profiles',
		JSON.stringify([{ id: 'p', label: 'Site', siteId: SITE, apiKey: 'clk_test' }]),
	);
	localStorage.setItem('facet.activeProfile', 'p');
});

describe('in-tile drill-down', () => {
	it('inspecting a row opens its composition and does NOT cross-filter the board', () => {
		const onSelect = vi.fn();
		wrap(<ListBody title="Countries" rows={COUNTRY_ROWS} onSelect={onSelect} drill={spec()} />);

		// Discoverable before the click: the affordance exists on every row, named after that row.
		expect(inspectControl('US')).toHaveAttribute('aria-expanded', 'false');

		fireEvent.click(inspectControl('US'));

		// Inspecting is not filtering. The board's segment is untouched.
		expect(onSelect).not.toHaveBeenCalled();
		expect(panel()).toBeInTheDocument();
	});

	it('composes a cube row from the cube, exactly, with no request', () => {
		wrap(<ListBody title="Countries" rows={COUNTRY_ROWS} drill={spec()} />);
		fireEvent.click(inspectControl('US'));

		const body = panel();
		// US = 100 + 60 + 20 pageviews, 10 + 6 + 2 events. Both additive, so both exact.
		expect(within(body).getByText('180')).toBeInTheDocument();
		expect(within(body).getByText('18')).toBeInTheDocument();
		// The first free axis is offered as the composition: desktop 100, mobile 80.
		expect(within(body).getByText('Devices')).toBeInTheDocument();
		expect(within(body).getByText('100')).toBeInTheDocument();
		expect(within(body).getByText('80')).toBeInTheDocument();
		// Nothing was fetched: the cube answered it.
		expect(statsMock).not.toHaveBeenCalled();
	});

	it('reports visitors as an upper bound only when summing cells would over-count', () => {
		const { unmount } = wrap(<ListBody title="Countries" rows={COUNTRY_ROWS} drill={spec()} />);
		fireEvent.click(inspectControl('US'));
		// US spans two cells inside bucket t=1, so 40 + 25 + 9 is an upper bound, and says so.
		expect(within(panel()).getByText('74')).toBeInTheDocument();
		expect(within(panel()).getByText(/upper bound/i)).toBeInTheDocument();
		unmount();

		wrap(<ListBody title="Countries" rows={COUNTRY_ROWS} drill={spec()} />);
		fireEvent.click(inspectControl('DE'));
		// DE is alone in its bucket, so its distinct count is exact and carries no caveat.
		expect(within(panel()).getByText('12')).toBeInTheDocument();
		expect(within(panel()).queryByText(/upper bound/i)).toBeNull();
	});

	it('composes with an active segment rather than ignoring it', () => {
		// A device=mobile segment is in force. Drilling US must mean "mobile US", not "US".
		wrap(
			<ListBody
				title="Countries"
				rows={COUNTRY_ROWS}
				drill={spec({ cubeFilter: { device: 'mobile' } })}
			/>,
		);
		fireEvent.click(inspectControl('US'));

		const body = panel();
		// mobile ∩ US = 60 + 20 pageviews, not 180.
		expect(within(body).getByText('80')).toBeInTheDocument();
		expect(within(body).queryByText('180')).toBeNull();
		// Device is pinned by the segment, country by the drill, so channel is what is left to split by.
		expect(within(body).getByText('Channels')).toBeInTheDocument();
		expect(within(body).queryByText('Devices')).toBeNull();
		// And the panel states that it is scoped to the filter, not just to the drill.
		expect(within(body).getByText(/scoped to the active filter/i)).toBeInTheDocument();
	});

	it('drills deeper and comes back through the breadcrumb', () => {
		wrap(<ListBody title="Countries" rows={COUNTRY_ROWS} drill={spec()} />);
		fireEvent.click(inspectControl('US'));

		fireEvent.click(screen.getByRole('button', { name: 'Narrow to device desktop' }));
		// US ∩ desktop is the single t=1 cell: 10 events, 40 visitors — one cell, so visitors is exact.
		expect(within(panel()).getByText('10')).toBeInTheDocument();
		expect(within(panel()).getByText('40')).toBeInTheDocument();
		expect(within(panel()).queryByText('180')).toBeNull();
		expect(within(panel()).queryByText(/upper bound/i)).toBeNull();

		fireEvent.click(screen.getByRole('button', { name: 'Back one level' }));
		expect(within(panel()).getByText('180')).toBeInTheDocument();

		// The breadcrumb root closes the panel and returns the list.
		fireEvent.click(within(panel()).getByRole('button', { name: 'Countries' }));
		expect(screen.queryByRole('region', { name: /breakdown$/ })).toBeNull();
		expect(inspectControl('US')).toBeInTheDocument();
	});

	it('routes a path drill to the server WITH the active segment, and never shows stale numbers', () => {
		const parent: StatsResponse = {
			summary: { pageviews: 9999, visitors: 111, events: 22 },
			series: [],
			top_paths: [],
			top_referrers: [],
			top_events: [],
			top_countries: [],
			top_devices: [],
			channels: [],
			engagement: { sessions: 0, bounce_rate: 0, pages_per_session: 0, avg_duration_ms: 0 },
		};
		// react-query hands back the PREVIOUS query's response as placeholder data. Under a drill that
		// would print the parent scope's numbers beneath the child's label, so the panel must wait.
		statsMock.mockReturnValue({
			data: parent,
			error: null,
			isPending: false,
			isPlaceholderData: true,
		});

		wrap(
			<ListBody
				title="Top pages"
				rows={[{ key: '/pricing', count: 500 }]}
				drill={spec({ axis: 'path', cubeFilter: { device: 'mobile' } })}
			/>,
		);
		fireEvent.click(inspectControl('/pricing'));

		expect(within(panel()).queryByText('9999')).toBeNull();

		// The whole scope travelled: the drilled path AND the segment's device.
		const query = statsMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
		expect(query).toMatchObject({ site_id: SITE, path: '/pricing', device: 'mobile' });
	});

	it('offers no drill on a dimension the API cannot filter, and says why', () => {
		wrap(
			<ListBody
				title="Browsers"
				rows={[{ key: 'Chrome', count: 90 }]}
				expanded
				drill={spec({ axis: null })}
				noun="Browser"
			/>,
		);
		expect(screen.queryByRole('button', { name: /Break down Chrome/ })).toBeNull();
		expect(screen.getByText(/not one of the five dimensions/i)).toBeInTheDocument();
	});

	it('keeps Cmd+A scoping: the row is data, the inspect control is chrome', () => {
		wrap(<ListBody title="Countries" rows={COUNTRY_ROWS} onSelect={vi.fn()} drill={spec()} />);
		expect(screen.getByRole('button', { name: /^US/ })).toHaveAttribute('data-selectable');
		expect(inspectControl('US')).toHaveAttribute('data-chrome');
	});

	it('a list with no drill spec behaves exactly as it did before', () => {
		wrap(<ListBody title="Countries" rows={COUNTRY_ROWS} onSelect={vi.fn()} />);
		expect(screen.queryByRole('button', { name: /Break down/ })).toBeNull();
		expect(screen.getByRole('button', { name: /^US/ })).toBeInTheDocument();
	});
});
