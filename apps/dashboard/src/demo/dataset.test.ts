// Invariants for the fabricated static-demo dataset: the builders must always return complete,
// well-shaped, non-degenerate data for any range, since the demo has no backend to fall back on.

import { describe, expect, it } from 'vitest';
import {
	buildAnomalies,
	buildCube,
	buildExperimentResult,
	buildFunnelReport,
	buildNlQuery,
	buildRealtime,
	buildRetention,
	buildStats,
	buildTimelineAnnotations,
} from './dataset.js';

const DAY_MS = 86_400_000;
const end = Date.UTC(2026, 5, 15);
const start = end - 30 * DAY_MS;

describe('demo dataset', () => {
	it('builds a non-empty daily cube spanning the range', () => {
		const cube = buildCube(start, end, 'day');
		expect(cube.interval).toBe('day');
		expect(cube.cells.length).toBeGreaterThan(100);
		for (const c of cube.cells) {
			expect(c.pageviews).toBeGreaterThan(0);
			expect(c.visitors).toBeGreaterThan(0);
			expect(c.events).toBeGreaterThanOrEqual(c.pageviews);
			expect(c.t).toBeGreaterThanOrEqual(Math.floor(start / DAY_MS) * DAY_MS);
			expect(c.t).toBeLessThan(end);
		}
	});

	it('derives a consistent, complete stats response', () => {
		const s = buildStats(start, end, 'day');
		expect(s.summary.pageviews).toBeGreaterThan(0);
		expect(s.summary.visitors).toBeGreaterThan(0);
		expect(s.summary.visitors).toBeLessThan(s.summary.pageviews);
		expect(s.series.length).toBeGreaterThan(0);
		// The pageview series must reconcile with the summary total.
		const seriesPv = s.series.reduce((a, p) => a + p.pageviews, 0);
		expect(seriesPv).toBe(s.summary.pageviews);
		// Every breakdown is present and sorted descending.
		for (const rows of [
			s.top_paths,
			s.top_countries,
			s.top_devices,
			s.channels,
			s.top_browsers ?? [],
		]) {
			expect(rows.length).toBeGreaterThan(0);
			for (let i = 1; i < rows.length; i++) {
				const prev = rows[i - 1];
				const cur = rows[i];
				if (prev && cur) expect(cur.count).toBeLessThanOrEqual(prev.count);
			}
		}
		// Revenue + all six attribution models present.
		expect(s.revenue?.currency).toBe('USD');
		for (const m of ['first', 'last', 'linear', 'position', 'time_decay', 'markov'] as const) {
			expect(s.attribution?.models[m]?.length).toBeGreaterThan(0);
		}
	});

	it('builds the remaining tab fixtures without degenerate values', () => {
		expect(buildRealtime().visitors).toBeGreaterThan(0);
		expect(buildAnomalies(start, end).anomalies.length).toBeGreaterThan(0);
		expect(buildTimelineAnnotations(start, end).annotations.length).toBeGreaterThan(0);
		const ret = buildRetention('week', start, end);
		expect(ret.cohorts.length).toBeGreaterThan(0);
		expect(ret.cohorts[0]?.retention[0]).toBe(1);
		expect(buildExperimentResult(start, end).variants.length).toBe(2);
		const funnel = buildFunnelReport(start, end);
		expect(funnel.overall_rate).toBeGreaterThan(0);
		expect(funnel.overall_rate).toBeLessThan(1);
		expect(buildNlQuery('where are my visitors?', start, end).result.kind).toBe('breakdown');
	});

	it('keeps every range-scoped fixture inside the window it was asked for', () => {
		// A marker or cohort outside the queried window is something the real API cannot return.
		const [anomaly] = buildAnomalies(start, end).anomalies;
		expect(anomaly?.bucket).toBeGreaterThanOrEqual(start);
		expect(anomaly?.bucket).toBeLessThan(end);
		for (const cohort of buildRetention('day', start, end).cohorts) {
			const t = Date.parse(`${cohort.cohort}T00:00:00.000Z`);
			expect(t).toBeGreaterThanOrEqual(start - DAY_MS);
			expect(t).toBeLessThanOrEqual(end);
		}
		// A window too short to hold one weekly cohort must not invent six of them.
		expect(buildRetention('week', end - 3 * DAY_MS, end).cohorts.length).toBe(1);
	});

	it('narrows every derived number when a dimension filter is applied', () => {
		const all = buildStats(start, end, 'day');
		const mobile = buildStats(start, end, 'day', { device: 'mobile' });
		expect(mobile.summary.pageviews).toBeGreaterThan(0);
		expect(mobile.summary.pageviews).toBeLessThan(all.summary.pageviews);
		expect(mobile.top_devices.map((r) => r.key)).toEqual(['mobile']);
		// A country filter narrows the same way, and leaves the country list on that country alone.
		const us = buildStats(start, end, 'day', { country: 'US' });
		expect(us.summary.pageviews).toBeLessThan(all.summary.pageviews);
		expect(us.top_countries.map((r) => r.key)).toEqual(['US']);
		// A high-cardinality path filter collapses its own breakdown to the matched row.
		const path = all.top_paths[1]?.key ?? '/pricing';
		const filtered = buildStats(start, end, 'day', { path });
		expect(filtered.top_paths.map((r) => r.key)).toEqual([path]);
		expect(filtered.summary.pageviews).toBeLessThan(all.summary.pageviews);
	});
});
