// The Experiments view: per-variant table (exposures / conversions / rate / Wilson CI / lift /
// p-value), a verdict banner, a sample-size read, the experiment's running state, and the
// multiple-comparisons caveat once a test has 3+ variants. The statistics helpers are checked
// against hand-computed values.

import type { ExperimentResult } from '@facet/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	Experiments,
	detectableEffect,
	familyWiseErrorRate,
	liftVsControl,
	requiredExposuresPerVariant,
	wilsonInterval,
} from '../components/Experiments.js';

type Variant = ExperimentResult['variants'][number];

/** Build a variant row; `rate` is derived exactly as the server derives it. */
function variant(
	key: string,
	exposures: number,
	conversions: number,
	extra: Partial<Variant> = {},
): Variant {
	return {
		key,
		exposures,
		conversions,
		rate: exposures === 0 ? 0 : conversions / exposures,
		p_value: null,
		significant: false,
		...extra,
	};
}

const experimentsMock = vi.fn();
const resultMock = vi.fn();

vi.mock('../hooks/experiments.js', () => ({
	useExperiments: () => experimentsMock(),
	useExperimentResult: () => resultMock(),
}));

vi.mock('../hooks/funnels.js', () => ({
	useGoals: () => ({
		data: {
			goals: [
				{
					id: 'g1',
					site_id: 'site-1',
					name: 'Signups',
					type: 'event',
					match_value: 'signup',
					created_at: 0,
				},
			],
		},
	}),
}));

vi.mock('../hooks/stats.js', () => ({
	useFreshness: () => ({ data: null }),
}));

function experiments(active = true) {
	return {
		data: {
			experiments: [
				{
					id: 'exp-1',
					site_id: 'site-1',
					name: 'CTA color',
					flag_key: 'cta',
					variants: [
						{ key: 'control', weight: 1 },
						{ key: 'blue', weight: 1 },
					],
					active,
					created_at: Date.now() - 3 * 86_400_000,
				},
			],
		},
	};
}

/** 10% vs 15% on 1,000 exposures each — a large, significant separation. */
const SIGNIFICANT: Variant[] = [
	variant('control', 1000, 100),
	variant('blue', 1000, 150, { p_value: 0.0026, significant: true }),
];

function withQuery(ui: ReactElement): ReactElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function renderExperiments() {
	return render(
		withQuery(
			<Experiments
				apiKey="clk_test"
				siteId="site-1"
				range={{ start: 0, end: 1 }}
				onOpenSettings={() => {}}
			/>,
		),
	);
}

beforeEach(() => {
	experimentsMock.mockReturnValue(experiments());
	resultMock.mockReturnValue({ data: { variants: SIGNIFICANT } });
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('Experiments statistics', () => {
	it('computes a 95% Wilson interval for a variant rate', () => {
		// n = 1000, c = 100, p = 0.1, z = 1.959964 (z² = 3.841455).
		//   centre = (0.1 + z²/2000) / (1 + z²/1000)         = 0.101531
		//   half   = z/(1 + z²/1000) · √(0.09/1000 + z²/4e6) = 0.018621
		// → [0.082909, 0.120152], matching the published Wilson interval (8.29%, 12.02%).
		const ci = wilsonInterval(100, 1000);
		expect(ci?.low).toBeCloseTo(0.082909, 6);
		expect(ci?.high).toBeCloseTo(0.120152, 6);
	});

	it('keeps the Wilson interval inside [0, 1] at zero conversions', () => {
		// 0/10 has no Wald interval at all (width 0); Wilson gives (0, 0.2775) — the reason for
		// choosing it. The lower bound is clamped at 0 rather than left slightly negative.
		const ci = wilsonInterval(0, 10);
		expect(ci?.low).toBe(0);
		expect(ci?.high).toBeCloseTo(0.277533, 6);
	});

	it('has no interval for an arm with no exposures', () => {
		expect(wilsonInterval(0, 0)).toBeNull();
	});

	it('sizes the exposures needed to confirm the observed difference', () => {
		// p₀ = 0.10, p₁ = 0.15, p̄ = 0.125:
		//   z_α·√(2·0.125·0.875) = 1.959964 · 0.467707 = 0.916690
		//   z_β·√(0.09 + 0.1275) = 0.841621 · 0.466369 = 0.392497
		//   (0.916690 + 0.392497)² / 0.05² = 685.60 → 686 per variant.
		const needed = requiredExposuresPerVariant(
			variant('control', 1000, 100),
			variant('b', 1000, 150),
		);
		expect(needed).toBe(686);
	});

	it('cannot size a difference that is not there, or an empty arm', () => {
		expect(
			requiredExposuresPerVariant(variant('control', 1000, 100), variant('b', 500, 50)),
		).toBeNull();
		expect(
			requiredExposuresPerVariant(variant('control', 1000, 100), variant('b', 0, 0)),
		).toBeNull();
	});

	it('reports the smallest effect the current sample could detect', () => {
		// (z_α + z_β)·√(2·0.1·0.9/1000) = 2.801585 · 0.0134164 = 0.0375872 → 3.76 points.
		expect(detectableEffect(0.1, 1000)).toBeCloseTo(0.0375872, 7);
		// No variance to detect against, and no sample at all.
		expect(detectableEffect(0, 1000)).toBeNull();
		expect(detectableEffect(0.1, 0)).toBeNull();
	});

	it('reports the family-wise error rate for k challengers', () => {
		expect(familyWiseErrorRate(1)).toBeCloseTo(0.05, 12);
		expect(familyWiseErrorRate(2)).toBeCloseTo(0.0975, 12); // 1 - 0.95²
		expect(familyWiseErrorRate(3)).toBeCloseTo(0.142625, 12); // 1 - 0.95³
		expect(familyWiseErrorRate(0)).toBe(0);
	});

	it('reports no lift for a variant with no exposures', () => {
		// 0 conversions on 0 exposures is "no data", not a -100% collapse.
		const control = variant('control', 1000, 100);
		expect(liftVsControl(variant('b', 0, 0), control)).toBeNull();
		expect(liftVsControl(variant('b', 1000, 150), control)).toBeCloseTo(0.5, 12);
	});
});

describe('Experiments', () => {
	it('renders the variant table with stat columns and a significance badge', () => {
		renderExperiments();
		expect(screen.getByText('Exposures')).toBeInTheDocument();
		expect(screen.getByText('Conversions')).toBeInTheDocument();
		expect(screen.getByText('p-value')).toBeInTheDocument();
		expect(screen.getAllByText('control').length).toBeGreaterThan(0);
		expect(screen.getAllByText('blue').length).toBeGreaterThan(0);
		expect(screen.getByText('0.0026')).toBeInTheDocument();
		expect(screen.getByText('sig')).toBeInTheDocument();
	});

	it('states a verdict naming the winning variant and its lift', () => {
		renderExperiments();
		// 15% vs 10% is a +50% relative lift, and the mocked result is significant.
		expect(screen.getByText(/is winning/)).toHaveTextContent('+50.0% lift');
		expect(screen.getByText(/is winning/)).toHaveTextContent('2,000 exposures');
	});

	it('reports lift against the control for each variant', () => {
		renderExperiments();
		expect(screen.getByText('Lift vs control')).toBeInTheDocument();
		expect(screen.getByText('+50.0%')).toBeInTheDocument();
	});

	it('shows a 95% confidence interval per variant', () => {
		renderExperiments();
		expect(screen.getByText('95% CI')).toBeInTheDocument();
		expect(screen.getByText('8.3–12.0%')).toBeInTheDocument();
		expect(screen.getByText('12.9–17.3%')).toBeInTheDocument();
	});

	it('states the resolution of the sample collected so far', () => {
		renderExperiments();
		// 1,000 exposures per arm at a 10% control rate resolves ~3.8 points (~38% relative).
		expect(screen.getByText(/can only resolve a gap/)).toHaveTextContent('3.8 points');
		expect(screen.getByText(/can only resolve a gap/)).toHaveTextContent('38% relative');
	});

	it('says how many more exposures an unresolved difference needs', () => {
		// 10% vs 11% on 400 exposures each: nowhere near separable yet.
		resultMock.mockReturnValue({
			data: {
				variants: [
					variant('control', 400, 40),
					variant('blue', 400, 44, { p_value: 0.6, significant: false }),
				],
			},
		});
		renderExperiments();
		const note = screen.getByText(/Confirming the gap now showing/);
		expect(note).toHaveTextContent('14,751 exposures per variant');
		expect(note).toHaveTextContent('14,351 more each');
	});

	it('shows the experiment running state and age', () => {
		renderExperiments();
		expect(screen.getByText('Running')).toBeInTheDocument();
		expect(screen.getByText(/day 4/)).toBeInTheDocument();
	});

	it('marks a stopped experiment in the status and the selector', () => {
		experimentsMock.mockReturnValue(experiments(false));
		renderExperiments();
		expect(screen.getByText('Stopped')).toBeInTheDocument();
		expect(screen.getByRole('option', { name: 'CTA color (stopped)' })).toBeInTheDocument();
	});

	it('distinguishes a variant with no exposures from a losing one', () => {
		resultMock.mockReturnValue({
			data: {
				variants: [variant('control', 1000, 100), variant('ghost', 0, 0)],
			},
		});
		renderExperiments();
		expect(screen.getByText('no exposures')).toBeInTheDocument();
		// The empty arm must not be reported as a -100% collapse against the control.
		expect(screen.queryByText('-100.0%')).not.toBeInTheDocument();
	});

	it('flags an experiment with no exposures at all instead of urging patience', () => {
		resultMock.mockReturnValue({
			data: { variants: [variant('control', 0, 0), variant('blue', 0, 0)] },
		});
		renderExperiments();
		expect(screen.getByText(/No exposures in this range/)).toBeInTheDocument();
	});

	it('warns about multiple comparisons when a winner only clears the unadjusted bar', () => {
		// Two challengers: the Bonferroni-adjusted bar is 0.05/2 = 0.025, which p = 0.03 misses.
		resultMock.mockReturnValue({
			data: {
				variants: [
					variant('control', 1000, 100),
					variant('blue', 1000, 130, { p_value: 0.03, significant: true }),
					variant('green', 1000, 105, { p_value: 0.7, significant: false }),
				],
			},
		});
		renderExperiments();
		const verdict = screen.getByText(/is ahead/);
		expect(verdict).toHaveTextContent('Bonferroni-adjusted bar here is 0.0250');
		expect(screen.getByText('unadjusted')).toBeInTheDocument();
		// 1 - 0.95² = 9.75% → "10%" chance of at least one false positive.
		expect(screen.getByText(/chances to clear/)).toHaveTextContent(
			'10% chance of at least one false positive',
		);
	});
});
