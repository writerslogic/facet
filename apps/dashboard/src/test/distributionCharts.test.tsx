// The four "shape of the data" charts: the packed bubble field, the calendar heatmap, the polar /
// nightingale clock, and the session distribution.
//
// These tests are weighted toward the claims each chart MAKES rather than the pixels it draws:
// that the packing is reproducible and never overlaps, that a box plot mark sits exactly on the
// order statistic the API sent (and nothing sits between two of them), that a calendar cell carries
// the UTC date it claims across a month boundary and a DST boundary, that suppression explains
// itself, and that every chart has a text equivalent carrying the numbers.

import type { ClockCell, CubeCell, SessionDistributionResponse } from '@facet/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { overallRate, segmentBubbles } from '../components/boxes/BubbleBox.js';
import { localFrame } from '../components/boxes/ClockBox.js';
import { filterMismatchNote } from '../components/boxes/DistributionBox.js';
import {
	BubbleField,
	type PackInput,
	type PackedBubble,
	packBubbles,
} from '../components/charts/Bubble.js';
import {
	CalendarHeatmap,
	calendarCells,
	dailyCounts,
	utcDayKey,
	utcDayStart,
} from '../components/charts/CalendarHeatmap.js';
import { DistributionChart, binScale, formatMetric } from '../components/charts/Distribution.js';
import {
	PolarClock,
	cellIndex,
	hourMarginal,
	shiftClockCells,
} from '../components/charts/PolarClock.js';
import { bandOf, intensityThresholds } from '../components/charts/ramp.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Testing-library's getByTitle only matches a `title` ATTRIBUTE or a `svg > title` child of the root
// svg. These charts put <title> inside the mark it describes (which is what actually surfaces the
// number on hover and to assistive tech), so the titles are collected directly.
function titlesIn(container: HTMLElement): string[] {
	return [...container.querySelectorAll('title')].map((t) => t.textContent ?? '');
}

// ── Bubble packing ────────────────────────────────────────────────────────────────────────────

/** A deliberately awkward field: a wide value spread, several exactly-coincident anchors. */
function packInput(): PackInput[] {
	return [
		{ id: 'direct', r: 60, ax: 120, ay: 90 },
		{ id: 'search', r: 44, ax: 130, ay: 95 },
		{ id: 'social', r: 30, ax: 120, ay: 90 },
		{ id: 'referral', r: 30, ax: 120, ay: 90 },
		{ id: 'email', r: 12, ax: 300, ay: 40 },
		{ id: 'paid', r: 8, ax: 40, ay: 200 },
		{ id: 'affiliate', r: 4, ax: 305, ay: 45 },
	];
}

function worstOverlap(packed: PackedBubble[]): number {
	let worst = 0;
	for (let i = 0; i < packed.length; i++) {
		for (let j = i + 1; j < packed.length; j++) {
			const a = packed[i] as PackedBubble;
			const b = packed[j] as PackedBubble;
			worst = Math.max(worst, a.r + b.r - Math.hypot(b.x - a.x, b.y - a.y));
		}
	}
	return worst;
}

describe('packBubbles', () => {
	const box = { width: 400, height: 240 };

	it('is deterministic: the same data packs to the same layout', () => {
		expect(packBubbles(packInput(), box)).toEqual(packBubbles(packInput(), box));
	});

	it('is independent of the caller"s array order — a refetch cannot jitter the field', () => {
		const forwards = packBubbles(packInput(), box);
		const shuffled = packBubbles([...packInput()].reverse(), box);
		const byId = new Map(shuffled.map((b) => [b.id, b]));
		for (const bubble of forwards) expect(byId.get(bubble.id)).toEqual(bubble);
	});

	it('never overlaps, even with exactly coincident anchors', () => {
		// Positive tolerance would let circles bleed into each other; the uniform final scale makes
		// this exact, so the only slack allowed is floating-point noise.
		expect(worstOverlap(packBubbles(packInput(), box))).toBeLessThan(1e-6);
	});

	it('never leaves its container at any tile size', () => {
		for (const size of [
			{ width: 400, height: 240 },
			{ width: 160, height: 120 },
			{ width: 900, height: 300 },
			{ width: 120, height: 460 },
		]) {
			for (const bubble of packBubbles(packInput(), size)) {
				expect(bubble.x - bubble.r).toBeGreaterThanOrEqual(-1e-6);
				expect(bubble.y - bubble.r).toBeGreaterThanOrEqual(-1e-6);
				expect(bubble.x + bubble.r).toBeLessThanOrEqual(size.width + 1e-6);
				expect(bubble.y + bubble.r).toBeLessThanOrEqual(size.height + 1e-6);
			}
			expect(worstOverlap(packBubbles(packInput(), size))).toBeLessThan(1e-6);
		}
	});

	it('keeps area proportional to value: a 4× value is a 2× radius', () => {
		const packed = packBubbles(
			[
				{ id: 'big', r: 40, ax: 60, ay: 60 },
				{ id: 'small', r: 20, ax: 240, ay: 160 },
			],
			box,
		);
		const big = packed.find((b) => b.id === 'big') as PackedBubble;
		const small = packed.find((b) => b.id === 'small') as PackedBubble;
		expect(big.r / small.r).toBeCloseTo(2, 5);
	});

	it('keeps every bubble near the position its axes asked for', () => {
		// Relaxation may displace a bubble, but a field where marks drift across the plot would make
		// both axes meaningless. The anchor is reported so the chart can draw it; check it is close.
		for (const bubble of packBubbles(packInput(), box)) {
			expect(Math.hypot(bubble.x - bubble.ax, bubble.y - bubble.ay)).toBeLessThan(140);
		}
	});

	it('handles the degenerate inputs a live board can produce', () => {
		expect(packBubbles([], box)).toEqual([]);
		expect(packBubbles(packInput(), { width: 0, height: 0 })).toEqual([]);
		const single = packBubbles([{ id: 'only', r: 500, ax: 0, ay: 0 }], box);
		expect(single).toHaveLength(1);
		expect((single[0] as PackedBubble).r).toBeLessThanOrEqual(box.height / 2);
	});
});

describe('segmentBubbles', () => {
	const cells: CubeCell[] = [
		{
			t: 0,
			device: 'mobile',
			country: 'US',
			channel: 'search',
			pageviews: 100,
			events: 20,
			visitors: 40,
		},
		{
			t: 100,
			device: 'desktop',
			country: 'US',
			channel: 'search',
			pageviews: 300,
			events: 30,
			visitors: 90,
		},
		{
			t: 0,
			device: 'mobile',
			country: 'DE',
			channel: 'direct',
			pageviews: 50,
			events: 50,
			visitors: 25,
		},
		{
			t: 100,
			device: 'mobile',
			country: 'DE',
			channel: 'direct',
			pageviews: 50,
			events: 0,
			visitors: 25,
		},
	];

	it('computes events per pageview and momentum from additive counts only', () => {
		const rows = segmentBubbles(cells, {}, 'channel', 50);
		const search = rows.find((r) => r.key === 'search');
		const direct = rows.find((r) => r.key === 'direct');
		expect(search?.value).toBe(400);
		expect(search?.x).toBeCloseTo(50 / 400, 10);
		// 100 in the first half, 300 in the second: (300 − 100) / 400.
		expect(search?.y).toBeCloseTo(0.5, 10);
		// Direct is flat across the halves, so it sits exactly on the zero line.
		expect(direct?.y).toBe(0);
		expect(overallRate(rows)).toBeCloseTo(100 / 500, 10);
	});

	it('applies the other axes"s filters but never the plotted axis"s own', () => {
		const rows = segmentBubbles(cells, { device: 'mobile', channel: 'search' }, 'channel', 50);
		// `direct` survives despite the channel filter (so it stays togglable), but is now mobile-only.
		expect(rows.map((r) => r.key).sort()).toEqual(['direct', 'search']);
		expect(rows.find((r) => r.key === 'search')?.value).toBe(100);
	});

	it('orders by volume with a stable tie-break, so the colour cycle never shuffles', () => {
		const tied: CubeCell[] = [
			{
				t: 0,
				device: 'a',
				country: 'X',
				channel: 'zeta',
				pageviews: 10,
				events: 1,
				visitors: 1,
			},
			{
				t: 0,
				device: 'b',
				country: 'X',
				channel: 'alpha',
				pageviews: 10,
				events: 1,
				visitors: 1,
			},
		];
		expect(segmentBubbles(tied, {}, 'channel', 0).map((r) => r.key)).toEqual(['alpha', 'zeta']);
	});
});

describe('BubbleField', () => {
	const data = [
		{ key: 'search', label: 'search', value: 400, x: 0.12, y: 0.5 },
		{ key: 'direct', label: 'direct', value: 100, x: 0.5, y: 0 },
	];

	function renderField(omitted = 0) {
		return render(
			<BubbleField
				data={data}
				valueLabel="pageviews"
				xLabel="events per pageview"
				yLabel="momentum"
				formatX={(v) => v.toFixed(2)}
				formatY={(v) => `${Math.round(v * 100)}%`}
				xReference={0.2}
				omitted={omitted}
				onSelect={() => {}}
				caption="Channel segments."
			/>,
		);
	}

	it('gives every bubble a keyboard-reachable, labelled control', () => {
		renderField();
		const marks = screen.getAllByRole('button');
		expect(marks).toHaveLength(data.length);
		for (const mark of marks) expect(mark).toHaveAttribute('tabindex', '0');
		expect(
			screen.getByLabelText(/search: 400 pageviews, 0.12 events per pageview, 50% momentum/),
		).toBeInTheDocument();
	});

	it('carries a text equivalent with all three encoded numbers per row', () => {
		const { container } = renderField();
		const table = container.querySelector('table.sr-only') as HTMLTableElement;
		expect(table).not.toBeNull();
		const headers = within(table)
			.getAllByRole('columnheader')
			.map((h) => h.textContent);
		expect(headers).toEqual(['Segment', 'pageviews', 'events per pageview', 'momentum']);
		expect(within(table).getAllByRole('row')).toHaveLength(data.length + 1);
	});

	it('says how many values it did not draw rather than implying it drew them all', () => {
		const { container } = renderField(6);
		expect(container.querySelector('caption')?.textContent).toContain(
			'6 smaller values are not drawn',
		);
	});
});

// ── Calendar ──────────────────────────────────────────────────────────────────────────────────

describe('calendarCells', () => {
	it('aligns each cell with the UTC weekday of the date it carries', () => {
		// 2026-03-04 is a Wednesday; 2026-04-02 a Thursday. The grid must place them on rows 3 and 4.
		const start = Date.parse('2026-03-04T00:00:00Z');
		const end = Date.parse('2026-04-03T00:00:00Z');
		const cells = calendarCells(start, end, new Map());
		const wednesday = cells.find((c) => utcDayKey(c.day) === '2026-03-04');
		const thursday = cells.find((c) => utcDayKey(c.day) === '2026-04-02');
		expect(wednesday?.row).toBe(3);
		expect(thursday?.row).toBe(4);
		// And the JS Date agrees, for every single cell — no off-by-one anywhere in the grid.
		for (const cell of cells) expect(new Date(cell.day).getUTCDay()).toBe(cell.row);
	});

	it('spans a month boundary without losing or duplicating a day', () => {
		const start = Date.parse('2026-03-04T00:00:00Z');
		const end = Date.parse('2026-04-03T00:00:00Z');
		const cells = calendarCells(start, end, new Map());
		const inRange = cells.filter((c) => c.inRange);
		// 2026-03-04 .. 2026-04-02 inclusive is 30 days.
		expect(inRange).toHaveLength(30);
		expect(new Set(inRange.map((c) => utcDayKey(c.day))).size).toBe(30);
		expect(utcDayKey(inRange[0]?.day ?? 0)).toBe('2026-03-04');
		expect(utcDayKey(inRange[inRange.length - 1]?.day ?? 0)).toBe('2026-04-02');
	});

	it('is unaffected by a DST boundary, because a UTC day is always 86400000 ms', () => {
		// US DST begins 2026-03-08 and EU DST begins 2026-03-29; both fall inside this window.
		const start = Date.parse('2026-03-01T00:00:00Z');
		const end = Date.parse('2026-04-01T00:00:00Z');
		const cells = calendarCells(start, end, new Map()).filter((c) => c.inRange);
		expect(cells).toHaveLength(31);
		for (let i = 1; i < cells.length; i++) {
			expect((cells[i]?.day ?? 0) - (cells[i - 1]?.day ?? 0)).toBe(DAY_MS);
		}
		// The two transition days are still exactly where the calendar says.
		expect(cells.find((c) => utcDayKey(c.day) === '2026-03-08')?.row).toBe(0);
		expect(cells.find((c) => utcDayKey(c.day) === '2026-03-29')?.row).toBe(0);
	});

	it('marks padding cells as outside the range instead of zero-filling them', () => {
		const start = Date.parse('2026-03-04T00:00:00Z'); // Wednesday
		const end = Date.parse('2026-03-11T00:00:00Z');
		const cells = calendarCells(start, end, new Map());
		const padded = cells.filter((c) => !c.inRange);
		// Sunday–Tuesday before the start, and Thursday–Saturday after the last day.
		expect(padded.map((c) => utcDayKey(c.day))).toEqual([
			'2026-03-01',
			'2026-03-02',
			'2026-03-03',
			'2026-03-11',
			'2026-03-12',
			'2026-03-13',
			'2026-03-14',
		]);
	});

	it('treats an exclusive end at midnight as covering the previous day', () => {
		const start = Date.parse('2026-03-04T00:00:00Z');
		const cells = calendarCells(start, start + DAY_MS, new Map()).filter((c) => c.inRange);
		expect(cells.map((c) => utcDayKey(c.day))).toEqual(['2026-03-04']);
	});
});

describe('dailyCounts', () => {
	it('rolls hourly buckets up to the UTC day that contains them', () => {
		const day = Date.parse('2026-03-04T00:00:00Z');
		const counts = dailyCounts([
			{ t: day + 3600_000, pageviews: 5 },
			{ t: day + 23 * 3600_000, pageviews: 7 },
			{ t: day + DAY_MS, pageviews: 2 },
		]);
		expect(counts.get(day)).toBe(12);
		expect(counts.get(day + DAY_MS)).toBe(2);
	});
});

describe('CalendarHeatmap', () => {
	const start = Date.parse('2026-03-04T00:00:00Z');
	const end = Date.parse('2026-03-11T00:00:00Z');
	const counts = new Map([
		[utcDayStart(start), 120],
		[utcDayStart(start + 2 * DAY_MS), 0],
		[utcDayStart(start + 3 * DAY_MS), 40],
	]);

	it('labels an out-of-range cell as outside the range, never as zero', () => {
		const { container } = render(<CalendarHeatmap start={start} end={end} counts={counts} />);
		expect(titlesIn(container)).toContain(
			'2026-03-01: outside the selected range — not queried',
		);
		expect(titlesIn(container)).toContain('2026-03-06 (UTC): 0 pageviews');
	});

	it('carries the number on every cell, so colour is never the only encoding', () => {
		const { container } = render(<CalendarHeatmap start={start} end={end} counts={counts} />);
		const titles = titlesIn(container);
		expect(titles).toContain('2026-03-04 (UTC): 120 pageviews');
		expect(titles).toContain('2026-03-07 (UTC): 40 pageviews');
		// Every cell in the grid, in range or not, carries one.
		expect(titles).toHaveLength(14);
	});

	it('renders a text equivalent that distinguishes the three cell states', () => {
		const { container } = render(<CalendarHeatmap start={start} end={end} counts={counts} />);
		const table = container.querySelector('table.sr-only') as HTMLTableElement;
		expect(table.textContent).toContain('outside the selected range');
		expect(within(table).getByRole('rowheader', { name: '2026-03-04' })).toBeInTheDocument();
		expect(container.querySelector('caption')?.textContent).toContain('160');
	});

	it('makes days activatable from the keyboard behind a single tab stop', () => {
		render(<CalendarHeatmap start={start} end={end} counts={counts} onSelectDay={() => {}} />);
		const days = screen.getAllByRole('button');
		expect(days).toHaveLength(7);
		expect(days.filter((d) => d.getAttribute('tabindex') === '0')).toHaveLength(1);
		expect(
			screen.getByRole('button', {
				name: '2026-03-04: 120 pageviews — narrow the range to this day',
			}),
		).toBeInTheDocument();
	});

	it('renders nothing rather than a fake grid when the range covers no whole day', () => {
		expect(calendarCells(start, start, new Map())).toEqual([]);
	});
});

// ── Clock ─────────────────────────────────────────────────────────────────────────────────────

function clockGrid(fill: (day: number, hour: number) => number): ClockCell[] {
	return Array.from({ length: 168 }, (_, i) => {
		const day = Math.floor(i / 24);
		const hour = i % 24;
		return { day, hour, pageviews: fill(day, hour), events: 0 };
	});
}

describe('shiftClockCells', () => {
	it('moves whole cells and preserves every total', () => {
		const cells = clockGrid((day, hour) => day * 100 + hour);
		const shifted = shiftClockCells(cells, 2);
		const sum = (list: readonly ClockCell[]) => list.reduce((s, c) => s + c.pageviews, 0);
		expect(sum(shifted)).toBe(sum(cells));
		// Monday 00:00 UTC becomes Monday 02:00 in a UTC+2 frame.
		expect(shifted[cellIndex(1, 2)]?.pageviews).toBe(100);
	});

	it('rolls the weekday over when the hour wraps, in both directions', () => {
		const cells: ClockCell[] = [
			{ day: 6, hour: 23, pageviews: 9, events: 1 },
			{ day: 0, hour: 0, pageviews: 5, events: 2 },
		];
		// +2: Saturday 23:00 → Sunday 01:00.
		expect(shiftClockCells(cells, 2)[cellIndex(0, 1)]?.pageviews).toBe(9);
		// −2: Sunday 00:00 → Saturday 22:00.
		expect(shiftClockCells(cells, -2)[cellIndex(6, 22)]?.pageviews).toBe(5);
	});

	it('is the identity at offset zero — the default costs the data nothing', () => {
		const cells = clockGrid((day, hour) => day + hour);
		expect(shiftClockCells(cells, 0)).toEqual(cells);
	});

	it('is a permutation: the multiset of cell counts is unchanged', () => {
		const cells = clockGrid((day, hour) => (day * 24 + hour) % 17);
		const before = cells.map((c) => c.pageviews).sort((a, b) => a - b);
		const after = shiftClockCells(cells, 5)
			.map((c) => c.pageviews)
			.sort((a, b) => a - b);
		expect(after).toEqual(before);
	});
});

describe('hourMarginal', () => {
	it('sums each hour across all seven weekdays', () => {
		expect(hourMarginal(clockGrid(() => 2))).toEqual(new Array(24).fill(14));
	});
});

describe('localFrame', () => {
	it('refuses a part-hour offset instead of rounding it', () => {
		// jsdom runs at UTC, so a part-hour offset has to be forced.
		const original = Date.prototype.getTimezoneOffset;
		Date.prototype.getTimezoneOffset = () => -330; // UTC+5:30
		try {
			const frame = localFrame({ start: 0, end: DAY_MS });
			expect(frame.offsetHours).toBeNull();
			expect(frame.label).toBe('UTC');
			expect(frame.note).toContain('UTC+5:30');
			expect(frame.note).toContain('whole hours only');
		} finally {
			Date.prototype.getTimezoneOffset = original;
		}
	});

	it('names a whole-hour offset with its sign rather than the word "local"', () => {
		const original = Date.prototype.getTimezoneOffset;
		Date.prototype.getTimezoneOffset = () => -120; // UTC+2
		try {
			const frame = localFrame({ start: 0, end: DAY_MS });
			expect(frame.offsetHours).toBe(2);
			expect(frame.label).toBe('UTC+2');
			expect(frame.note).toBeNull();
		} finally {
			Date.prototype.getTimezoneOffset = original;
		}
	});

	it('says which offset it used when the range crosses a DST change', () => {
		const original = Date.prototype.getTimezoneOffset;
		// Winter at the start of the range, summer by the end.
		Date.prototype.getTimezoneOffset = function (this: Date) {
			return this.getTime() < DAY_MS ? 0 : -60;
		};
		try {
			const frame = localFrame({ start: 0, end: 4 * DAY_MS });
			expect(frame.offsetHours).toBe(1);
			expect(frame.note).toContain('daylight-saving');
			expect(frame.note).toContain('UTC+0');
			expect(frame.note).toContain('UTC+1');
		} finally {
			Date.prototype.getTimezoneOffset = original;
		}
	});
});

describe('PolarClock', () => {
	const cells = clockGrid((day, hour) => (hour >= 8 && hour < 18 ? 10 + day : 1));

	it('draws all 168 cells, each labelled with its weekday, hour, frame and number', () => {
		const { container } = render(<PolarClock cells={cells} variant="grid" frameLabel="UTC" />);
		expect(container.querySelectorAll('svg path')).toHaveLength(168);
		const titles = titlesIn(container);
		expect(titles).toHaveLength(168);
		expect(titles).toContain('Monday 09:00 UTC: 11 pageviews');
		expect(titles).toContain('Sunday 03:00 UTC: 1 pageviews');
	});

	it('names the time frame on the chart itself, not only in a legend', () => {
		const { container, rerender } = render(
			<PolarClock cells={cells} variant="grid" frameLabel="UTC" />,
		);
		expect(container.querySelector('svg')?.textContent).toContain('UTC');
		rerender(
			<PolarClock
				cells={cells}
				variant="grid"
				frameLabel="UTC+2"
				note="Shifted client-side."
			/>,
		);
		expect(container.querySelector('svg')?.textContent).toContain('UTC+2');
		expect(container.textContent).toContain('Shifted client-side.');
	});

	it('collapses to 24 petals in the nightingale view', () => {
		const { container } = render(
			<PolarClock cells={cells} variant="nightingale" frameLabel="UTC" />,
		);
		expect(container.querySelectorAll('svg path')).toHaveLength(24);
		expect(titlesIn(container)).toContain('09:00 UTC: 91 pageviews');
	});

	it('carries a full 24 × 7 text equivalent labelled with the frame', () => {
		const { container } = render(
			<PolarClock cells={cells} variant="grid" frameLabel="UTC+2" />,
		);
		const table = container.querySelector('table.sr-only') as HTMLTableElement;
		expect(
			within(table).getByRole('columnheader', { name: 'Hour (UTC+2)' }),
		).toBeInTheDocument();
		// 24 hour rows plus the header row.
		expect(within(table).getAllByRole('row')).toHaveLength(25);
		expect(within(table).getAllByRole('columnheader')).toHaveLength(8);
	});

	it('keeps the grid one tab stop while every cell stays reachable', () => {
		const { container } = render(<PolarClock cells={cells} variant="grid" frameLabel="UTC" />);
		const focusable = container.querySelectorAll('g[tabindex]');
		expect(focusable).toHaveLength(168);
		expect(container.querySelectorAll('g[tabindex="0"]')).toHaveLength(1);
	});
});

// ── Distribution ──────────────────────────────────────────────────────────────────────────────

/**
 * A hand-built sample of 20 sessions whose order statistics can be checked by hand.
 * Sorted: 1..20 pages. `floor(p × (n − 1))` with n = 20 gives index `floor(19p)`, so
 * p25 → index 4 → 5, p50 → index 9 → 10, p75 → index 14 → 15, p05 → index 0 → 1, p95 → index 18 → 19.
 */
const PAGE_SAMPLE = Array.from({ length: 20 }, (_, i) => i + 1);

function nearestRankLower(sorted: number[], q: number): number {
	return sorted[Math.floor(q * (sorted.length - 1))] as number;
}

const DISTRIBUTION: SessionDistributionResponse = {
	count: 20,
	suppressed: false,
	min_count: 25,
	percentile_method: 'nearest-rank-lower',
	duration_ms: null,
	pageviews: {
		min: 1,
		max: 20,
		mean: 10.5,
		percentiles: {
			p05: nearestRankLower(PAGE_SAMPLE, 0.05),
			p10: nearestRankLower(PAGE_SAMPLE, 0.1),
			p25: nearestRankLower(PAGE_SAMPLE, 0.25),
			p50: nearestRankLower(PAGE_SAMPLE, 0.5),
			p75: nearestRankLower(PAGE_SAMPLE, 0.75),
			p90: nearestRankLower(PAGE_SAMPLE, 0.9),
			p95: nearestRankLower(PAGE_SAMPLE, 0.95),
			p99: nearestRankLower(PAGE_SAMPLE, 0.99),
		},
		histogram: [
			{ from: 0, to: 1, count: 0 },
			{ from: 1, to: 2, count: 1 },
			{ from: 2, to: 3, count: 1 },
			{ from: 3, to: 4, count: 1 },
			{ from: 4, to: 5, count: 1 },
			{ from: 5, to: 6, count: 1 },
			{ from: 6, to: 11, count: 5 },
			{ from: 11, to: 21, count: 10 },
			{ from: 21, to: null, count: 0 },
		],
	},
	meta: { materialization: 'hourly', pending: false },
};

describe('nearest-rank order statistics', () => {
	it('the fixture matches the documented index formula, so the geometry below is checkable', () => {
		const p = DISTRIBUTION.pageviews?.percentiles;
		expect(p?.p05).toBe(1);
		expect(p?.p25).toBe(5);
		expect(p?.p50).toBe(10);
		expect(p?.p75).toBe(15);
		expect(p?.p95).toBe(19);
		// The whole point: an interpolated quartile of 1..20 would be 5.75, a value no session had.
		expect(p?.p25).not.toBeCloseTo(5.75, 2);
	});
});

describe('binScale', () => {
	const bins = DISTRIBUTION.pageviews?.histogram ?? [];
	const scale = binScale(bins, 20);

	it('gives every bin an equal slot, so bar height is proportional to bin area', () => {
		// Bin i starts at i / 9 of the plot.
		expect(scale.toUnit(0)).toBeCloseTo(0, 10);
		expect(scale.toUnit(1)).toBeCloseTo(1 / 9, 10);
		expect(scale.toUnit(6)).toBeCloseTo(6 / 9, 10);
		expect(scale.toUnit(11)).toBeCloseTo(7 / 9, 10);
	});

	it('places a value linearly inside its own bin', () => {
		// 8 sits 2/5 of the way through the [6, 11) bin, which is bin index 6 of 9.
		expect(scale.toUnit(8)).toBeCloseTo((6 + 2 / 5) / 9, 10);
	});

	it('is monotone across the whole domain', () => {
		let previous = Number.NEGATIVE_INFINITY;
		for (let v = 0; v <= 30; v += 0.25) {
			const unit = scale.toUnit(v);
			expect(unit).toBeGreaterThanOrEqual(previous - 1e-12);
			previous = unit;
		}
	});

	it('closes the open-ended final bin at the observed maximum, never an invented edge', () => {
		expect(binScale(bins, 40).openEdge).toBe(40);
		// The last bin starts at 21; a max that does not exceed it still yields a monotone scale.
		expect(binScale(bins, 5).openEdge).toBeGreaterThan(21);
	});
});

describe('DistributionChart', () => {
	it('draws a mark for every one of the eleven statistics, at the value it was given', () => {
		const { container } = render(<DistributionChart data={DISTRIBUTION} metric="pageviews" />);
		const titles = titlesIn(container);
		for (const [level, value] of Object.entries(DISTRIBUTION.pageviews?.percentiles ?? {})) {
			expect(titles).toContain(`${level} = ${formatMetric(value, 'pageviews')}`);
		}
		expect(titles).toContain('min = 1');
		expect(titles).toContain('max = 20');
		expect(titles.some((t) => t.startsWith('mean = 10.5'))).toBe(true);
	});

	it('positions the box edges exactly on p25 and p75, with no interpolation', () => {
		const { container } = render(<DistributionChart data={DISTRIBUTION} metric="pageviews" />);
		const scale = binScale(DISTRIBUTION.pageviews?.histogram ?? [], 20);
		// Plot geometry mirrors the component's constants; a change to either must break this test.
		const PAD_LEFT = 16;
		const PLOT_W = 480 - 16 - 16;
		const box = [...container.querySelectorAll('rect')].find(
			(r) => r.getAttribute('rx') === '2',
		) as SVGRectElement;
		const expectedLeft = PAD_LEFT + scale.toUnit(5) * PLOT_W;
		const expectedWidth = (scale.toUnit(15) - scale.toUnit(5)) * PLOT_W;
		expect(Number(box.getAttribute('x'))).toBeCloseTo(expectedLeft, 6);
		expect(Number(box.getAttribute('width'))).toBeCloseTo(expectedWidth, 6);
	});

	it('states the percentile method on the chart and in its text equivalent', () => {
		const { container } = render(<DistributionChart data={DISTRIBUTION} metric="pageviews" />);
		// The two caveats live in HTML beside the drawing, not inside the scaling viewBox, so that a
		// small tile cannot shrink them away.
		expect(container.textContent).toContain('nearest-rank-lower');
		expect(container.querySelector('svg')?.textContent).not.toContain('nearest-rank-lower');
		expect(container.querySelector('caption')?.textContent).toContain(
			'nearest-rank-lower order statistics',
		);
		expect(container.querySelector('caption')?.textContent).toContain(
			'not an interpolated quartile',
		);
	});

	it('labels the axis as per-bin rather than letting it read as linear', () => {
		const { container } = render(<DistributionChart data={DISTRIBUTION} metric="pageviews" />);
		expect(container.textContent).toContain('one slot per histogram bin');
	});

	it('lists every statistic and every bin in the text equivalent', () => {
		const { container } = render(<DistributionChart data={DISTRIBUTION} metric="pageviews" />);
		const table = container.querySelector('table.sr-only') as HTMLTableElement;
		for (const level of ['p05', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95', 'p99']) {
			expect(within(table).getByRole('rowheader', { name: level })).toBeInTheDocument();
		}
		expect(
			within(table).getByRole('rowheader', { name: 'Sessions in 21+' }),
		).toBeInTheDocument();
		expect(
			within(table).getByRole('rowheader', { name: 'Mean (not an order statistic)' }),
		).toBeInTheDocument();
	});

	it('marks the open-ended bin so its right edge is not read as a real boundary', () => {
		const { container } = render(<DistributionChart data={DISTRIBUTION} metric="pageviews" />);
		expect(titlesIn(container)).toContain('21+: 0 sessions');
	});

	it('explains suppression instead of drawing an empty box', () => {
		const suppressed: SessionDistributionResponse = {
			count: 7,
			suppressed: true,
			min_count: 25,
			percentile_method: 'nearest-rank-lower',
			duration_ms: null,
			pageviews: null,
			meta: { materialization: 'hourly', pending: false },
		};
		const { container } = render(<DistributionChart data={suppressed} metric="duration" />);
		expect(screen.getByText(/7 of 25 sessions needed/)).toBeInTheDocument();
		expect(container.textContent).toContain('eleven order statistics');
		expect(container.textContent).toContain('Widen the date range');
		// No box, no whisker, no violin — nothing that could be read as a distribution. Scoped past
		// `aria-hidden` so the state's own shield glyph (shared with every withheld state on the
		// board) is not mistaken for plotted geometry: the chart's svg is the one that is NOT hidden.
		expect(container.querySelector('svg:not([aria-hidden="true"])')).toBeNull();
		expect(container.querySelector('.sr-only')?.textContent).toContain('7 sessions matched');
	});

	it('does not fabricate the metric the response withheld', () => {
		// `duration_ms` is null on this fixture even though it is not suppressed overall — the chart
		// must fall through to the same explanation rather than plotting the other metric's numbers.
		const { container } = render(<DistributionChart data={DISTRIBUTION} metric="duration" />);
		expect(container.querySelector('svg:not([aria-hidden="true"])')).toBeNull();
	});

	it('surfaces the filters this endpoint cannot honour', () => {
		render(
			<DistributionChart
				data={DISTRIBUTION}
				metric="pageviews"
				filterNote={filterMismatchNote(['country', 'device'])}
			/>,
		);
		expect(screen.getByText(/Not sliced by country, device/)).toBeInTheDocument();
		expect(screen.getByText(/Channel filters DO apply/)).toBeInTheDocument();
	});
});

describe('filterMismatchNote', () => {
	it('is silent when the board and this tile really do agree', () => {
		expect(filterMismatchNote([])).toBeNull();
	});
});

describe('formatMetric', () => {
	it('reads durations in the unit a human would use', () => {
		expect(formatMetric(500, 'duration')).toBe('500ms');
		expect(formatMetric(5000, 'duration')).toBe('5.0s');
		expect(formatMetric(90_000, 'duration')).toBe('1.5m');
		expect(formatMetric(3, 'pageviews')).toBe('3');
	});
});

// ── Ramp ──────────────────────────────────────────────────────────────────────────────────────

describe('intensity ramp', () => {
	it('cuts bands at nearest-rank quantiles of the positive values only', () => {
		const values = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const thresholds = intensityThresholds(values);
		// Positive sample is 1..10, n = 10, so cut points are indices 1, 3, 5, 7 → 2, 4, 6, 8.
		expect(thresholds).toEqual([2, 4, 6, 8]);
		expect(bandOf(0, thresholds)).toBe(-1);
		expect(bandOf(1, thresholds)).toBe(0);
		expect(bandOf(10, thresholds)).toBe(4);
	});

	it('keeps zero distinguishable from the faintest positive band', () => {
		expect(bandOf(0, [1, 2, 3, 4])).toBe(-1);
		expect(bandOf(0.5, [1, 2, 3, 4])).toBe(0);
	});

	it('survives an all-zero grid without inventing a band', () => {
		expect(intensityThresholds([0, 0, 0])).toEqual([]);
		expect(bandOf(0, [])).toBe(-1);
	});
});
