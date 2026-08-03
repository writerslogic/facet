// The arithmetic behind the funnel and retention views. These are the numbers a reader acts on
// (where the funnel leaks, what average retention actually is), so they're pinned rather than left
// to visual inspection.

import { describe, expect, it } from 'vitest';
import { funnelSteps, worstStep } from '../components/FunnelChart.js';
import { periodAverages } from '../components/Retention.js';

const report = {
	overall_rate: 0.1,
	steps: [
		{ index: 0, match_value: '/', count: 1000 },
		{ index: 1, match_value: '/pricing', count: 400 },
		{ index: 2, match_value: 'add_to_cart', count: 320 },
		{ index: 3, match_value: 'checkout', count: 100 },
	],
};

describe('funnelSteps', () => {
	it('reports share-of-entry and step-over-step conversion separately', () => {
		const steps = funnelSteps(report);
		expect(steps.map((s) => s.shareOfEntry)).toEqual([1, 0.4, 0.32, 0.1]);
		// Step 2 keeps 40% of entrants but 80% of the step above it — the two rates differ, which is
		// exactly why both are shown.
		expect(steps[2]?.shareOfEntry).toBeCloseTo(0.32);
		expect(steps[2]?.stepRate).toBeCloseTo(0.8);
	});

	it('leaves the first step without a preceding-step rate or loss', () => {
		const [first] = funnelSteps(report);
		expect(first?.stepRate).toBeNull();
		expect(first?.lost).toBeNull();
	});

	it('counts people lost at each step', () => {
		expect(funnelSteps(report).map((s) => s.lost)).toEqual([null, 600, 80, 220]);
	});

	it('survives an empty funnel and a zero-entry funnel without dividing by zero', () => {
		expect(funnelSteps({ overall_rate: 0, steps: [] })).toEqual([]);
		const zero = funnelSteps({
			overall_rate: 0,
			steps: [
				{ index: 0, match_value: 'a', count: 0 },
				{ index: 1, match_value: 'b', count: 0 },
			],
		});
		expect(zero[0]?.shareOfEntry).toBe(0);
		expect(zero[1]?.stepRate).toBeNull();
	});
});

describe('worstStep', () => {
	it('picks the step losing the most people in absolute terms, not the worst rate', () => {
		// Step 3 has the worse RATE (31% continue vs 40%), but step 1 loses more people (600 vs 220),
		// and absolute loss is what's worth fixing first.
		expect(worstStep(funnelSteps(report))?.index).toBe(1);
	});

	it('returns null when nothing is lost', () => {
		const flat = funnelSteps({
			overall_rate: 1,
			steps: [
				{ index: 0, match_value: 'a', count: 50 },
				{ index: 1, match_value: 'b', count: 50 },
			],
		});
		expect(worstStep(flat)).toBeNull();
	});
});

describe('periodAverages', () => {
	it('weights each cohort by its size rather than treating cohorts equally', () => {
		const cohorts = [
			{ size: 1000, retention: [1, 0.5] },
			{ size: 10, retention: [1, 1] },
		];
		// An unweighted mean would say 75%; the small cohort must not swing it that far.
		expect(periodAverages(cohorts, 2)[1]).toBeCloseTo((0.5 * 1000 + 1 * 10) / 1010);
	});

	it('ignores cohorts that have not reached a period yet', () => {
		const cohorts = [
			{ size: 100, retention: [1, 0.4, 0.2] },
			{ size: 100, retention: [1, 0.6] },
		];
		expect(periodAverages(cohorts, 3)[1]).toBeCloseTo(0.5);
		expect(periodAverages(cohorts, 3)[2]).toBeCloseTo(0.2);
	});

	it('returns null for a period no cohort has reached', () => {
		expect(periodAverages([{ size: 10, retention: [1] }], 3)[2]).toBeNull();
	});

	it('returns null rather than NaN when every cohort is empty', () => {
		expect(periodAverages([{ size: 0, retention: [1] }], 1)[0]).toBeNull();
	});
});
