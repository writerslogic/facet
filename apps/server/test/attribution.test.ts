// Multi-touch attribution engine: heuristic models + Markov removal-effect over day-scoped channel paths.

import { describe, expect, it } from 'vitest';
import { computeAttribution } from '../src/lib/attribution.js';

/** Map a model's rows to a { channel: credit } object for easy assertions. */
function credit(rows: { key: string; count: number }[]): Record<string, number> {
	return Object.fromEntries(rows.map((r) => [r.key, r.count]));
}

describe('computeAttribution', () => {
	it('is empty with no converting paths', () => {
		const r = computeAttribution([{ channels: ['Organic'], value: 0, converted: false }]);
		expect(r.conversions).toBe(0);
		expect(r.revenue).toBe(0);
		expect(r.models.last).toEqual([]);
	});

	it('credits the sole channel fully under every model for a single-touch conversion', () => {
		const r = computeAttribution([{ channels: ['Paid'], value: 100, converted: true }]);
		expect(r.conversions).toBe(1);
		expect(r.revenue).toBe(100);
		for (const m of ['first', 'last', 'linear', 'position', 'time_decay', 'markov'] as const) {
			expect(credit(r.models[m])).toEqual({ Paid: 100 });
		}
	});

	it('distributes a two-touch path per model, including Markov removal-effect', () => {
		const r = computeAttribution([
			{ channels: ['Organic', 'Direct'], value: 100, converted: true },
			{ channels: ['Organic'], value: 0, converted: false },
		]);
		expect(credit(r.models.first)).toEqual({ Organic: 100 });
		expect(credit(r.models.last)).toEqual({ Direct: 100 });
		expect(credit(r.models.linear)).toEqual({ Organic: 50, Direct: 50 });
		expect(credit(r.models.position)).toEqual({ Organic: 50, Direct: 50 });
		// Time decay: weights 1:2 → Organic 33, Direct 67.
		expect(credit(r.models.time_decay)).toEqual({
			Organic: 33,
			Direct: 67,
		});
		// Markov: Organic branches 50/50 to Direct-or-null; removing either drops conversion to 0 → 50/50.
		expect(credit(r.models.markov)).toEqual({ Organic: 50, Direct: 50 });
	});

	it('collapses consecutive duplicate touches before attributing', () => {
		const r = computeAttribution([
			{
				channels: ['Organic', 'Organic', 'Direct'],
				value: 100,
				converted: true,
			},
		]);
		// Collapsed to [Organic, Direct]: linear splits 50/50, not 33/33/33.
		expect(credit(r.models.linear)).toEqual({ Organic: 50, Direct: 50 });
	});
});
