// the funnel chart renders one bar per step (width proportional to the first step) with the
// overall rate, and the conversions list renders one row per goal.
//
// Also pinned here: the numbers a reader acts on that funnelDerived.test.ts does not cover — the
// size of the prize for fixing the worst step, the period-over-period comparison, and the per-row
// failure path for goal conversions (which used to render as a permanent em dash).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversions } from '../components/Conversions.js';
import { FunnelChart, funnelSteps, funnelUpside, stepDeltas } from '../components/FunnelChart.js';
// `formatPoints` moved to lib/format when a second surface (goal conversions, then experiments)
// needed it; the funnel is no longer its only caller.
import { formatPoints } from '../lib/format.js';

/** Per-goal conversion queries, stubbed so the row's success/failure/trend paths are reachable. */
const pending = (): Record<string, unknown> => ({
	data: undefined,
	isError: false,
	isFetching: false,
	refetch: () => {},
});

const conversions = vi.hoisted(() => ({
	impl: (_goalId: string, _range: { start: number; end: number }): Record<string, unknown> => ({
		data: undefined,
		isError: false,
		isFetching: false,
		refetch: () => {},
	}),
}));

// Each test owns the stub outright, so one test's failure/trend setup can't leak into the next.
beforeEach(() => {
	conversions.impl = pending;
});

vi.mock('../hooks/funnels.js', () => ({
	useConversions: (
		_apiKey: string,
		_siteId: string,
		goalId: string,
		range: { start: number; end: number },
	) => conversions.impl(goalId, range),
}));

function withQuery(ui: ReactElement): ReactElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const threeSteps = {
	steps: [
		{ index: 0, match_value: '/', count: 100 },
		{ index: 1, match_value: '/pricing', count: 40 },
		{ index: 2, match_value: 'signup', count: 12 },
	],
	overall_rate: 0.12,
};

const fourSteps = {
	overall_rate: 0.1,
	steps: [
		{ index: 0, match_value: '/', count: 1000 },
		{ index: 1, match_value: '/pricing', count: 400 },
		{ index: 2, match_value: 'add_to_cart', count: 320 },
		{ index: 3, match_value: 'checkout', count: 100 },
	],
};

const goal = {
	id: 'g1',
	site_id: 'site-1',
	name: 'Signups',
	type: 'event' as const,
	match_value: 'signup',
	created_at: 0,
};

describe('FunnelChart', () => {
	it('renders one bar per step and the overall rate', () => {
		render(<FunnelChart report={threeSteps} />);
		expect(screen.getAllByTestId('funnel-bar')).toHaveLength(3);
		expect(screen.getByText('12%')).toBeInTheDocument();
		// The step label appears twice now: once in its row, once in the biggest-drop callout.
		expect(screen.getAllByText('/pricing').length).toBeGreaterThan(0);
	});

	it('calls out the step that loses the most people', () => {
		render(<FunnelChart report={threeSteps} />);
		// Step 2 loses 60 people vs step 3's 28, so it is the one named.
		const callout = screen.getByText(/Biggest drop-off at step/);
		expect(callout).toHaveTextContent('step 2');
		expect(callout).toHaveTextContent('60');
	});

	it('shows step-over-step conversion alongside share of entrants', () => {
		render(<FunnelChart report={threeSteps} />);
		// Step 3 keeps 30% of step 2, but is only 12% of everyone who entered.
		expect(screen.getByText('30% continued')).toBeInTheDocument();
		expect(screen.getByText('12% of everyone who entered')).toBeInTheDocument();
	});

	it('shows the absolute loss on every step without needing a hover', () => {
		render(<FunnelChart report={threeSteps} />);
		expect(screen.getByText('−60 lost here')).toBeInTheDocument();
		expect(screen.getByText('−28 lost here')).toBeInTheDocument();
	});

	it('quantifies what fixing the worst step is worth', () => {
		render(<FunnelChart report={fourSteps} />);
		const callout = screen.getByText(/more would complete it/);
		expect(callout).toHaveTextContent('Lift step 2 to 80%');
		expect(callout).toHaveTextContent('100');
	});

	it('omits the upside callout when the worst step already converts best', () => {
		// 100 → 40 → 12: the worst step (40%) is the funnel's best rate, so there is no proven bar to
		// lift it to and the chart must not invent one.
		render(<FunnelChart report={threeSteps} />);
		expect(screen.queryByText(/more would complete it/)).not.toBeInTheDocument();
	});

	it('distinguishes a funnel nobody entered from a funnel with no steps', () => {
		const { unmount } = render(
			<FunnelChart
				report={{
					steps: [
						{ index: 0, match_value: '/', count: 0 },
						{ index: 1, match_value: '/pricing', count: 0 },
					],
					overall_rate: 0,
				}}
			/>,
		);
		expect(screen.getByText('No one entered this funnel')).toBeInTheDocument();
		// No misleading zero-width bars in this state.
		expect(screen.queryAllByTestId('funnel-bar')).toHaveLength(0);
		unmount();

		render(<FunnelChart report={{ steps: [], overall_rate: 0 }} />);
		expect(screen.getByText('This funnel has no steps')).toBeInTheDocument();
	});

	it('says so when a funnel has only one step to report', () => {
		render(
			<FunnelChart
				report={{ steps: [{ index: 0, match_value: '/', count: 50 }], overall_rate: 1 }}
			/>,
		);
		expect(screen.getByText('A one-step funnel has no drop-off to measure.')).toBeVisible();
		expect(screen.getAllByTestId('funnel-bar')).toHaveLength(1);
	});

	it('compares the overall rate and each step against the preceding period', () => {
		render(
			<FunnelChart
				report={threeSteps}
				previous={{
					steps: [
						{ index: 0, match_value: '/', count: 80 },
						{ index: 1, match_value: '/pricing', count: 40 },
						{ index: 2, match_value: 'signup', count: 8 },
					],
					overall_rate: 0.1,
				}}
			/>,
		);
		// Rendered through the shared DeltaBadge now, so the figure and its label are separate
		// elements: the badge carries the number, the chrome beside it carries the wording.
		expect(screen.getByText('+2.0 pts')).toBeInTheDocument();
		expect(screen.getByText('vs previous')).toBeInTheDocument();
		// Step 1 has no rate, so it compares entrants instead.
		expect(screen.getByText('+20')).toBeInTheDocument();
		expect(screen.getByText('entered')).toBeInTheDocument();
		// Step 2 kept 50% of entrants last period and 40% now.
		expect(screen.getByText('−10.0 pts')).toBeInTheDocument();
	});
});

describe('funnelUpside', () => {
	it('prices the worst step against the best rate the funnel already achieves', () => {
		const upside = funnelUpside(funnelSteps(fourSteps));
		// Worst step is /pricing (600 lost) at 40%; the funnel's best step converts at 80%. Lifting it
		// adds 400 people there, and they still have to clear 80% then 31.25% → +100 completions.
		expect(upside?.step.index).toBe(1);
		expect(upside?.targetRate).toBeCloseTo(0.8);
		expect(upside?.gain).toBe(100);
	});

	it('returns null when the worst step is already the best-converting one', () => {
		const flat = funnelSteps({
			overall_rate: 0.5,
			steps: [
				{ index: 0, match_value: 'a', count: 100 },
				{ index: 1, match_value: 'b', count: 50 },
			],
		});
		expect(funnelUpside(flat)).toBeNull();
	});

	it('returns null when no step loses anyone', () => {
		expect(
			funnelUpside(
				funnelSteps({
					overall_rate: 1,
					steps: [
						{ index: 0, match_value: 'a', count: 10 },
						{ index: 1, match_value: 'b', count: 10 },
					],
				}),
			),
		).toBeNull();
	});

	it('caps the target rate at 100% so a >1 rate could never inflate the prize', () => {
		// The server can't emit a step count above the one before it, but the estimate must stay sane
		// if that invariant ever breaks (step 3 converts at 150% here).
		const upside = funnelUpside(
			funnelSteps({
				overall_rate: 0.3,
				steps: [
					{ index: 0, match_value: 'a', count: 100 },
					{ index: 1, match_value: 'b', count: 20 },
					{ index: 2, match_value: 'c', count: 30 },
				],
			}),
		);
		expect(upside?.targetRate).toBe(1);
		// (1 − 0.2) × 100 entrants; the 1.5 downstream rate is clamped to 1 so the estimate can never
		// promise more completions than people rescued.
		expect(upside?.gain).toBe(80);
	});
});

describe('stepDeltas', () => {
	const current = funnelSteps(threeSteps);

	it('aligns periods by step index, not array position', () => {
		// The previous period is missing step 1, so step 2 must not be compared against step 1's data.
		const previous = funnelSteps({
			overall_rate: 0.2,
			steps: [
				{ index: 1, match_value: '/pricing', count: 50 },
				{ index: 2, match_value: 'signup', count: 10 },
			],
		});
		const deltas = stepDeltas(current, previous);
		expect(deltas[0]).toBeNull();
		expect(deltas[1]?.count).toBe(-10);
		// Step 2 is the previous period's entry step, so it has no rate to compare against.
		expect(deltas[1]?.rate).toBeNull();
	});

	it('reports one null per step when there is no previous period', () => {
		expect(stepDeltas(current, null)).toEqual([null, null, null]);
		expect(stepDeltas(current, [])).toEqual([null, null, null]);
	});

	it('measures rate movement in points', () => {
		const previous = funnelSteps({
			overall_rate: 0.1,
			steps: [
				{ index: 0, match_value: '/', count: 80 },
				{ index: 1, match_value: '/pricing', count: 40 },
				{ index: 2, match_value: 'signup', count: 8 },
			],
		});
		expect(stepDeltas(current, previous)[1]?.rate).toBeCloseTo(0.4 - 0.5);
	});
});

describe('formatPoints', () => {
	it('signs the change and never renders a negative zero', () => {
		expect(formatPoints(0.08)).toBe('+8.0 pts');
		expect(formatPoints(-0.125)).toBe('−12.5 pts');
		expect(formatPoints(-0.0001)).toBe('±0.0 pts');
	});
});

describe('Conversions', () => {
	it('renders one row per goal', () => {
		render(
			withQuery(
				<Conversions
					apiKey="clk_test"
					siteId="site-1"
					range={{ start: 100, end: 200 }}
					onOpenSettings={() => {}}
					goals={[goal]}
				/>,
			),
		);
		expect(screen.getByText('Signups')).toBeInTheDocument();
	});

	it('surfaces a failed conversion query instead of an em dash, with a retry', () => {
		conversions.impl = () => ({
			data: undefined,
			isError: true,
			error: new Error('request_failed'),
			isFetching: false,
			refetch: () => {},
		});
		render(
			withQuery(
				<Conversions
					apiKey="clk_test"
					siteId="site-1"
					range={{ start: 100, end: 200 }}
					onOpenSettings={() => {}}
					goals={[goal]}
				/>,
			),
		);
		expect(screen.getByText('Unavailable')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
		expect(screen.queryByText('—')).not.toBeInTheDocument();
	});

	it('shows each goal trend against the equal-length preceding window', () => {
		// The row asks for the active range and the window before it; only the start distinguishes them.
		conversions.impl = (_goalId, range) => ({
			data: {
				goal_id: 'g1',
				conversions: 10,
				sessions: 200,
				rate: range.start === 100 ? 0.05 : 0.03,
			},
			isError: false,
			isFetching: false,
			refetch: () => {},
		});
		render(
			withQuery(
				<Conversions
					apiKey="clk_test"
					siteId="site-1"
					range={{ start: 100, end: 200 }}
					onOpenSettings={() => {}}
					goals={[goal]}
				/>,
			),
		);
		expect(screen.getByText('+2.0 pts')).toBeInTheDocument();
	});
});
