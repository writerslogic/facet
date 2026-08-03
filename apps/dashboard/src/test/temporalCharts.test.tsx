// The two temporal charts: the scale/window arithmetic, the focus + dim behaviour, the brush's
// keyboard path, and the text equivalent every chart owes a screen reader.
//
// The canvas itself is mocked. jsdom has no 2d context, and what is worth pinning here is not "uPlot
// drew something" but the maths that decides WHAT it draws — which is why all of it is pure and
// lives in hooks/timeseries.ts rather than inside a component.

import type { DimensionSeries } from '@facet/shared';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('uplot', () => ({
	default: class {
		constructor(_opts: unknown, _data: unknown, container: HTMLElement) {
			const node = document.createElement('div');
			node.className = 'uplot';
			container.appendChild(node);
		}
		readonly series = [{}, {}, {}, {}];
		readonly data = [[]];
		setSize(): void {}
		setData(): void {}
		setScale(): void {}
		redraw(): void {}
		destroy(): void {}
	},
}));
vi.mock('uplot/dist/uPlot.min.css', () => ({}));

import { BrushRange } from '../components/charts/BrushRange.js';
import { MultiLine } from '../components/charts/MultiLine.js';
import {
	HUE_ORDER,
	bucketTimes,
	clampWindow,
	dashOf,
	drawableSeries,
	fullWindow,
	hueOf,
	hueVar,
	indexAtX,
	isFullWindow,
	keyStep,
	moveWindow,
	resizeWindow,
	setEdge,
	summarize,
	valuesOf,
	windowFromPixels,
	windowLabel,
	windowMax,
	windowToPixels,
	xAtIndex,
} from '../hooks/timeseries.js';
import { useSeriesFocus } from '../lib/chartInteraction.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 2, 1);

function line(key: string, values: number[]): DimensionSeries {
	return {
		key,
		total: values.reduce((a, b) => a + b, 0),
		points: values.map((v, i) => ({
			t: T0 + i * HOUR,
			pageviews: v,
			events: Math.round(v / 2),
		})),
	};
}

const SERIES: DimensionSeries[] = [
	line('/', [10, 20, 30, 40, 10]),
	line('/pricing', [5, 5, 5, 5, 30]),
	line('/docs', [1, 2, 3, 4, 5]),
];

// Reduced motion makes `useSpring` snap, so a rendered chart settles synchronously instead of
// animating across frames the test would have to await.
beforeAll(() => {
	window.matchMedia = ((query: string) =>
		({
			matches: query.includes('prefers-reduced-motion'),
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}) as unknown as MediaQueryList) as typeof window.matchMedia;
});

describe('bucket geometry', () => {
	it('takes the x-axis from the longest series so a short line cannot truncate it', () => {
		const times = bucketTimes([line('a', [1, 2]), line('b', [1, 2, 3, 4])]);
		expect(times).toHaveLength(4);
		expect(times[0]).toBe(T0);
		expect(times[3]).toBe(T0 + 3 * HOUR);
	});

	it('pads a short line with nulls, never with zeros', () => {
		// A zero is "nothing happened here"; a null is "we have no bucket here". Padding with zero
		// would draw a trough the data never had.
		expect(valuesOf(line('a', [4, 5]), 'pageviews', 4)).toEqual([4, 5, null, null]);
	});

	it('reads the chosen metric', () => {
		expect(valuesOf(line('a', [10, 20]), 'events', 2)).toEqual([5, 10]);
	});

	it('maps pixels to buckets and back', () => {
		expect(indexAtX(0, 300, 5)).toBe(0);
		expect(indexAtX(300, 300, 5)).toBe(4);
		expect(indexAtX(150, 300, 5)).toBe(2);
		expect(xAtIndex(2, 300, 5)).toBe(150);
		// Round-trip on every bucket: the crosshair must land on the point it is drawn over.
		for (let i = 0; i < 5; i++) expect(indexAtX(xAtIndex(i, 300, 5), 300, 5)).toBe(i);
	});

	it('degrades safely on a zero-width or single-bucket axis', () => {
		expect(indexAtX(120, 0, 5)).toBe(0);
		expect(indexAtX(120, 300, 1)).toBe(0);
		expect(xAtIndex(3, 300, 1)).toBe(0);
	});
});

describe('brush window derivation', () => {
	it('orders, rounds and clamps into the axis', () => {
		expect(clampWindow({ from: 8, to: 2 }, 10)).toEqual({ from: 2, to: 8 });
		expect(clampWindow({ from: -5, to: 99 }, 10)).toEqual({ from: 0, to: 9 });
		expect(clampWindow({ from: 2.4, to: 6.6 }, 10)).toEqual({ from: 2, to: 7 });
	});

	it('never produces a window narrower than the minimum span', () => {
		expect(clampWindow({ from: 4, to: 4 }, 10)).toEqual({ from: 4, to: 6 });
		// Pinned at the right edge it grows leftwards rather than off the end of the axis.
		expect(clampWindow({ from: 9, to: 9 }, 10)).toEqual({ from: 7, to: 9 });
		// An axis shorter than the minimum span is the whole axis, not an out-of-range window.
		expect(clampWindow({ from: 0, to: 0 }, 2)).toEqual({ from: 0, to: 1 });
	});

	it('derives the window from a pixel drag in either direction', () => {
		expect(windowFromPixels(0, 300, 300, 11)).toEqual({ from: 0, to: 10 });
		// Dragging right-to-left selects the same window as left-to-right.
		expect(windowFromPixels(240, 60, 300, 11)).toEqual(windowFromPixels(60, 240, 300, 11));
	});

	it('draws the rectangle over the buckets it selects, not just their centres', () => {
		const rect = windowToPixels({ from: 2, to: 4 }, 400, 5);
		// Bucket centres are at 200 and 400; the rect bleeds half a bucket each way and is clipped
		// to the track, so it covers the selection rather than ending on the last point.
		expect(rect.left).toBeCloseTo(150);
		expect(rect.left + rect.width).toBeCloseTo(400);
		expect(windowToPixels(fullWindow(5), 400, 5)).toEqual({ left: 0, width: 400 });
	});

	it('moves the window without changing its span, and stops at the ends', () => {
		expect(moveWindow({ from: 2, to: 5 }, 3, 20)).toEqual({ from: 5, to: 8 });
		const pinned = moveWindow({ from: 15, to: 18 }, 99, 20);
		expect(pinned).toEqual({ from: 16, to: 19 });
		expect(pinned.to - pinned.from).toBe(3);
		expect(moveWindow({ from: 2, to: 5 }, -99, 20)).toEqual({ from: 0, to: 3 });
	});

	it('resizes one edge at a time', () => {
		expect(resizeWindow({ from: 4, to: 10 }, 'start', -2, 20)).toEqual({ from: 2, to: 10 });
		expect(resizeWindow({ from: 4, to: 10 }, 'end', 3, 20)).toEqual({ from: 4, to: 13 });
		// Collapsing an edge past the other still respects the minimum span.
		expect(resizeWindow({ from: 4, to: 10 }, 'end', -99, 20)).toEqual({ from: 4, to: 6 });
	});

	it('puts an edge on a bucket without letting it pass the other one', () => {
		expect(setEdge({ from: 4, to: 10 }, 'start', 7, 20)).toEqual({ from: 7, to: 10 });
		// Dragging the end handle left past the start collapses against it — it must NOT swap the
		// two and mirror the window to the other side of the chart.
		expect(setEdge({ from: 4, to: 10 }, 'end', 0, 20)).toEqual({ from: 4, to: 6 });
		expect(setEdge({ from: 4, to: 10 }, 'start', 19, 20)).toEqual({ from: 8, to: 10 });
	});

	it('scales the keyboard step with the axis', () => {
		expect(keyStep(50)).toBe(1);
		expect(keyStep(2160)).toBe(22);
		expect(keyStep(2160, true)).toBe(220);
	});

	it('knows when it is showing everything', () => {
		expect(isFullWindow(fullWindow(24), 24)).toBe(true);
		expect(isFullWindow({ from: 1, to: 23 }, 24)).toBe(false);
	});

	it('describes the window in UTC for the accessible value', () => {
		const times = bucketTimes(SERIES);
		expect(windowLabel(times, { from: 0, to: 2 }, 'hour')).toContain('UTC');
		expect(windowLabel(times, { from: 0, to: 2 }, 'hour')).toContain('3 hours');
		expect(windowLabel(times, { from: 0, to: 0 }, 'day')).toContain('1 day');
	});
});

describe('window readouts', () => {
	it('takes the y-domain from the visible window only', () => {
		expect(windowMax(SERIES, 'pageviews', 0, 4)).toBe(40);
		expect(windowMax(SERIES, 'pageviews', 0, 1)).toBe(20);
		expect(windowMax(SERIES, 'pageviews', 4, 4)).toBe(30);
	});

	it('summarizes each line inside the window, with shares of the shown lines', () => {
		const rows = summarize(SERIES, 'pageviews', 0, 4);
		expect(rows.map((r) => r.total)).toEqual([110, 50, 15]);
		expect(rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1);
		expect(rows[0]?.peak).toBe(40);
		expect(rows[0]?.peakIndex).toBe(3);
		// Windowing changes the totals, so the readout follows the zoom rather than the range.
		expect(summarize(SERIES, 'pageviews', 3, 4)[1]?.total).toBe(35);
	});

	it('reports zero shares rather than dividing by zero on an empty window', () => {
		const rows = summarize([line('a', [0, 0])], 'pageviews', 0, 1);
		expect(rows[0]?.share).toBe(0);
	});
});

describe('categorical hues', () => {
	it('hands out hues in the separation-ordered permutation, cycling past six', () => {
		expect(HUE_ORDER).toHaveLength(6);
		expect(new Set(HUE_ORDER).size).toBe(6);
		expect(hueVar(0)).toBe('var(--c3)');
		expect(hueVar(6)).toBe(hueVar(0));
		const cat = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
		expect(hueOf(cat, 0)).toBe('c3');
		expect(hueOf(cat, 1)).toBe('c5');
		expect(hueOf(cat, 7)).toBe(hueOf(cat, 1));
	});

	it('gives every line a distinct dash pattern so hue is never the only key', () => {
		const patterns = Array.from({ length: 8 }, (_, i) => JSON.stringify(dashOf(i)));
		expect(new Set(patterns).size).toBe(8);
		// The top-ranked line stays solid — it is the one most often read on its own.
		expect(dashOf(0)).toBeUndefined();
	});

	it('returns a fresh dash array each call, so a consumer cannot mutate the table', () => {
		const first = dashOf(1) as number[];
		first[0] = 999;
		expect(dashOf(1)?.[0]).toBe(7);
	});
});

describe('MultiLine focus', () => {
	function renderChart() {
		return render(
			<MultiLine
				series={SERIES}
				interval="hour"
				metric="pageviews"
				dimensionLabel="Page"
				truncated
			/>,
		);
	}

	it('makes the legend the selector: one keyboard-reachable button per line', () => {
		renderChart();
		for (const key of ['/', '/pricing', '/docs']) {
			const button = screen.getByRole('button', { name: new RegExp(`${key}\\s`) });
			expect(button.tagName).toBe('BUTTON');
			expect(button).toHaveAttribute('aria-pressed', 'false');
		}
	});

	it('toggles focus on and off, and reports it via aria-pressed', () => {
		renderChart();
		const pricing = screen.getByRole('button', { name: /\/pricing/ });
		fireEvent.click(pricing);
		expect(pricing).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByRole('button', { name: /\/docs/ })).toHaveAttribute(
			'aria-pressed',
			'false',
		);
		fireEvent.click(pricing);
		expect(pricing).toHaveAttribute('aria-pressed', 'false');
	});

	it('dims the unselected lines to the shared level rather than hiding them', () => {
		// The chart hands `opacityFor` straight to the canvas, so this is the contract the fade
		// depends on: 0.18 (shared across every chart) and never 0 — the other lines are still the
		// answer to "compared with what".
		const { result } = renderHook(() => useSeriesFocus());
		act(() => result.current.setFocused('/pricing'));
		expect(result.current.opacityFor('/pricing')).toBe(1);
		expect(result.current.opacityFor('/')).toBe(0.18);
		expect(result.current.isDimmed('/')).toBe(true);

		renderChart();
		const docs = screen.getByRole('button', { name: /\/docs/ });
		expect(docs.className).not.toContain('opacity-50');
		fireEvent.click(screen.getByRole('button', { name: /\/pricing/ }));
		expect(docs.className).toContain('opacity-50');
	});

	it('reveals the selected line detail — its total and its share of the shown lines', () => {
		renderChart();
		fireEvent.click(screen.getByRole('button', { name: /\/pricing/ }));
		expect(screen.getByText('50 pageviews')).toBeInTheDocument();
		// 50 of 175 shown pageviews.
		expect(screen.getByText('29% of shown')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
		expect(screen.queryByText('29% of shown')).not.toBeInTheDocument();
	});

	it('says the shares are of the shown lines when a tail was dropped', () => {
		renderChart();
		expect(
			screen.getByText(/shares are of these lines, not of all traffic/),
		).toBeInTheDocument();
	});

	it('carries a text equivalent: a table of totals, shares and peaks', () => {
		const { container } = renderChart();
		const table = container.querySelector('table.sr-only') as HTMLElement;
		expect(table).not.toBeNull();
		expect(within(table).getByText(/5 hourly buckets/)).toBeInTheDocument();
		const row = within(table).getByRole('rowheader', { name: '/pricing' }).closest('tr');
		expect(row).not.toBeNull();
		expect(within(row as HTMLElement).getByText('50')).toBeInTheDocument();
		expect(within(row as HTMLElement).getByText('30')).toBeInTheDocument();
	});

	// The wording is the shared `ChartEmpty` "outside the range" case, not a bare "No data yet": every
	// chart on the board now distinguishes nothing-recorded from withheld-for-privacy from
	// nothing-in-this-window, and says which one it is in words rather than by an absent chart.
	it('says WHY it is empty rather than drawing an empty canvas when there are no series', () => {
		render(<MultiLine series={[]} interval="day" metric="pageviews" dimensionLabel="Page" />);
		expect(screen.getByText('Nothing in this range')).toBeInTheDocument();
		expect(screen.getByText(/no pageviews were recorded for any page/i)).toBeInTheDocument();
	});

	// A malformed series is a whole-app crash, not a blank tile: MultiLine indexes `points` directly,
	// and an uncaught throw inside a React render unmounts the entire dashboard.
	it('drops a series with no points rather than throwing during render', () => {
		const broken = [{ key: '/x', total: 1 }] as unknown as Parameters<typeof drawableSeries>[0];
		expect(drawableSeries(broken)).toEqual([]);
		render(
			<MultiLine
				series={drawableSeries(broken)}
				interval="day"
				metric="pageviews"
				dimensionLabel="Page"
			/>,
		);
		expect(screen.getByText('Nothing in this range')).toBeInTheDocument();
	});
});

describe('BrushRange keyboard operation', () => {
	function renderBrush() {
		return render(
			<BrushRange series={SERIES} interval="hour" metric="pageviews" dimensionLabel="Page" />,
		);
	}

	it('exposes three named sliders: the window itself and each edge', () => {
		renderBrush();
		expect(screen.getByRole('slider', { name: /Time window/ })).toBeInTheDocument();
		expect(screen.getByRole('slider', { name: 'Window start' })).toBeInTheDocument();
		expect(screen.getByRole('slider', { name: 'Window end' })).toBeInTheDocument();
	});

	it('announces the current value in UTC on each edge', () => {
		renderBrush();
		expect(screen.getByRole('slider', { name: 'Window start' })).toHaveAttribute(
			'aria-valuetext',
			expect.stringContaining('start'),
		);
		expect(
			screen.getByRole('slider', { name: 'Window end' }).getAttribute('aria-valuetext'),
		).toContain('UTC');
	});

	it('resizes from the end edge with the arrow keys', () => {
		renderBrush();
		const end = screen.getByRole('slider', { name: 'Window end' });
		expect(end).toHaveAttribute('aria-valuenow', '4');
		fireEvent.keyDown(end, { key: 'ArrowLeft' });
		expect(end).toHaveAttribute('aria-valuenow', '3');
		fireEvent.keyDown(end, { key: 'ArrowRight' });
		expect(end).toHaveAttribute('aria-valuenow', '4');
	});

	it('resizes from the start edge, and stops at the minimum span', () => {
		renderBrush();
		const start = screen.getByRole('slider', { name: 'Window start' });
		fireEvent.keyDown(start, { key: 'ArrowRight' });
		expect(start).toHaveAttribute('aria-valuenow', '1');
		fireEvent.keyDown(start, { key: 'ArrowRight' });
		fireEvent.keyDown(start, { key: 'ArrowRight' });
		fireEvent.keyDown(start, { key: 'ArrowRight' });
		// 5 buckets, minimum span 3 → the start edge cannot pass index 2.
		expect(start).toHaveAttribute('aria-valuenow', '2');
	});

	it('pans the whole window without changing its span', () => {
		renderBrush();
		const end = screen.getByRole('slider', { name: 'Window end' });
		const body = screen.getByRole('slider', { name: /Time window/ });
		fireEvent.keyDown(end, { key: 'ArrowLeft' });
		fireEvent.keyDown(end, { key: 'ArrowLeft' });
		expect(body).toHaveAttribute('aria-valuenow', '0');
		expect(end).toHaveAttribute('aria-valuenow', '2');
		fireEvent.keyDown(body, { key: 'ArrowRight' });
		expect(body).toHaveAttribute('aria-valuenow', '1');
		expect(end).toHaveAttribute('aria-valuenow', '3');
	});

	it('resets to the whole range with Escape and with the reset control', () => {
		renderBrush();
		const end = screen.getByRole('slider', { name: 'Window end' });
		const reset = screen.getByRole('button', { name: 'Reset zoom' });
		expect(reset).toBeDisabled();
		fireEvent.keyDown(end, { key: 'ArrowLeft' });
		expect(reset).toBeEnabled();
		fireEvent.keyDown(end, { key: 'Escape' });
		expect(end).toHaveAttribute('aria-valuenow', '4');
		expect(reset).toBeDisabled();
		fireEvent.keyDown(end, { key: 'ArrowLeft' });
		fireEvent.click(reset);
		expect(end).toHaveAttribute('aria-valuenow', '4');
	});

	it('rewrites its text equivalent for the selected window', () => {
		const { container } = renderBrush();
		const table = () => container.querySelector('table.sr-only') as HTMLElement;
		expect(within(table()).getByText(/zoomed to the whole range/)).toBeInTheDocument();
		fireEvent.keyDown(screen.getByRole('slider', { name: 'Window start' }), {
			key: 'ArrowRight',
		});
		fireEvent.keyDown(screen.getByRole('slider', { name: 'Window start' }), {
			key: 'ArrowRight',
		});
		// Window is now buckets 2–4: '/' contributes 30 + 40 + 10 = 80, not its 110 range total.
		const row = within(table()).getByRole('rowheader', { name: '/' }).closest('tr');
		expect(within(row as HTMLElement).getByText('80')).toBeInTheDocument();
	});

	it('labels the minimap as the combined total of the shown keys, not of the site', () => {
		renderBrush();
		expect(screen.getByText(/combined pageviews of the 3 keys shown/i)).toBeInTheDocument();
	});
});
