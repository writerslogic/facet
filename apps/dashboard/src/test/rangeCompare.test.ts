// presets + custom ranges resolve correctly, invalid custom ranges are rejected,
// the compare window is exactly the preceding period, and zero-baseline deltas never go Infinity/NaN.

import { describe, expect, it } from 'vitest';
import { computeDelta, formatDeltaPct } from '../lib/format.js';
import {
	MAX_RANGE_MS,
	parseDateInput,
	previousRange,
	rangeForPreset,
	resolveRange,
	validateCustomRange,
} from '../state.js';

describe('range resolution', () => {
	it('resolves a preset to a start<end window ending near now', () => {
		const now = 1_700_000_000_000;
		const r = rangeForPreset('7d', now);
		expect(r.end).toBe(now);
		expect(now - r.start).toBe(7 * 24 * 60 * 60 * 1000);
	});

	it('resolves a custom selection to its explicit window', () => {
		const r = resolveRange({ kind: 'custom', start: 100, end: 200 });
		expect(r).toEqual({ start: 100, end: 200 });
	});
});

describe('validateCustomRange', () => {
	it('accepts a valid in-bounds range', () => {
		expect(validateCustomRange(0, 1000)).toBeNull();
	});

	it('rejects start >= end', () => {
		expect(validateCustomRange(500, 500)).toMatch(/before/);
		expect(validateCustomRange(600, 500)).toMatch(/before/);
	});

	it('rejects a span over the 90-day maximum', () => {
		expect(validateCustomRange(0, MAX_RANGE_MS + 1)).toMatch(/90 days/);
	});

	it('parses a UTC date-input value', () => {
		expect(parseDateInput('2024-01-02')).toBe(Date.parse('2024-01-02T00:00:00.000Z'));
		expect(Number.isNaN(parseDateInput('nope'))).toBe(true);
	});
});

describe('previousRange', () => {
	it('is the same-duration window immediately preceding the primary', () => {
		const primary = { start: 1000, end: 4000 };
		expect(previousRange(primary)).toEqual({ start: -2000, end: 1000 });
	});
});

describe('computeDelta', () => {
	it('computes absolute + pct for a normal comparison', () => {
		const d = computeDelta(150, 100, 'up');
		expect(d.absolute).toBe(50);
		expect(d.pct).toBeCloseTo(0.5);
		expect(d.sense).toBe('improvement');
	});

	it('never yields Infinity/NaN when the previous value is zero', () => {
		const d = computeDelta(10, 0, 'up');
		expect(d.pct).toBeNull();
		expect(d.isNew).toBe(true);
		expect(Number.isFinite(d.absolute)).toBe(true);
		expect(formatDeltaPct(d)).toBe('new');
	});

	it('treats a fall as improvement when direction is down (bounce rate)', () => {
		const d = computeDelta(0.2, 0.4, 'down');
		expect(d.sense).toBe('improvement');
	});

	it('is neutral for a neutral-direction metric', () => {
		const d = computeDelta(10, 5, 'neutral');
		expect(d.sense).toBe('neutral');
	});
});
