import type { CountRow, SeriesPoint } from '@facet/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// uPlot needs a real canvas which jsdom lacks. Mock it so we can assert the wrapper mounts a
// `.uplot` node fed with two series (pageviews + visitors) without a live canvas. The chart fetches
// uPlot through a dynamic import, so the mock is resolved a microtask after render — hence the
// `waitFor`s below rather than synchronous assertions.
const uplotCalls: Array<{ opts: unknown; data: unknown }> = [];

vi.mock('uplot', () => {
	return {
		default: class {
			constructor(opts: unknown, data: unknown, container: HTMLElement) {
				uplotCalls.push({ opts, data });
				const node = document.createElement('div');
				node.className = 'uplot';
				container.appendChild(node);
			}
			setSize() {}
			destroy() {}
		},
	};
});

vi.mock('uplot/dist/uPlot.min.css', () => ({}));

import { KpiCards } from '../components/KpiCards.js';
import { TrafficChart } from '../components/TrafficChart.js';
import { WorldMap } from '../components/WorldMap.js';

describe('KpiCards', () => {
	it('renders the three formatted KPI numbers', () => {
		render(<KpiCards summary={{ pageviews: 12345, visitors: 6789, events: 42 }} />);
		expect(screen.getByText('12,345')).toBeInTheDocument();
		expect(screen.getByText('6,789')).toBeInTheDocument();
		expect(screen.getByText('42')).toBeInTheDocument();
	});
});

describe('TrafficChart', () => {
	it('mounts a .uplot node fed with two series', async () => {
		const series: SeriesPoint[] = [
			{ t: 1_700_000_000_000, pageviews: 10, visitors: 4 },
			{ t: 1_700_003_600_000, pageviews: 20, visitors: 9 },
		];
		const { container } = render(<TrafficChart series={series} />);

		await waitFor(() => expect(container.querySelector('.uplot')).not.toBeNull());

		const call = uplotCalls.at(-1);
		expect(call).toBeDefined();
		const data = call?.data as number[][];
		// [x, pageviews, visitors] => three rows, two of which are the series.
		expect(data).toHaveLength(3);
		expect(data[1]).toEqual([10, 20]);
		expect(data[2]).toEqual([4, 9]);
	});

	// The container reserves the chart's height before uPlot's chunk lands, so the content below a
	// chart doesn't jump when it mounts.
	it('reserves the chart height before uPlot loads', () => {
		const series: SeriesPoint[] = [{ t: 1_700_000_000_000, pageviews: 10, visitors: 4 }];
		const { container } = render(<TrafficChart series={series} height={240} />);
		const box = container.querySelector<HTMLElement>('.uplot-container');
		expect(box?.style.minHeight).toBe('240px');
	});

	it('shows the empty state for an empty series', () => {
		render(<TrafficChart series={[]} />);
		// "No data yet" restated the obvious. An empty series is a claim about the SELECTED RANGE,
		// and the copy now says so and names the two things that change it.
		expect(screen.getByText('No traffic recorded in the selected range')).toBeInTheDocument();
		expect(screen.getByText(/Widen the date range/)).toBeInTheDocument();
	});
});

describe('WorldMap', () => {
	const rows: CountRow[] = [
		{ key: 'us', count: 120 },
		{ key: 'de', count: 40 },
	];

	// The geometry is a dynamically-imported chunk; the surrounding readout and top-5 list must be
	// usable immediately, and the map itself fills in once the chunk resolves.
	it('renders the country list up front and the map once the geometry loads', async () => {
		const { container } = render(<WorldMap rows={rows} />);

		// Two matches each now: the visible top-5 row and the sr-only table that gives the map a text
		// equivalent (the visible list truncates at five and hides entirely on a narrow tile).
		expect(screen.getAllByText('US').length).toBeGreaterThan(0);
		expect(screen.getAllByText('DE').length).toBeGreaterThan(0);
		const equivalent = container.querySelector('table.sr-only');
		expect(equivalent).not.toBeNull();
		expect(equivalent?.querySelectorAll('tbody tr')).toHaveLength(rows.length);

		await waitFor(() =>
			expect(container.querySelector('svg[aria-label="Traffic by country"]')).not.toBeNull(),
		);
		expect(container.querySelectorAll('path').length).toBeGreaterThan(100);

		// The choropleth still shades: countries in `rows` get a ramp fill, the rest the flat no-data
		// tint. Guards the lazy geometry against silently rendering an unshaded map.
		const fills = [...container.querySelectorAll('path')].map((p) => p.getAttribute('fill'));
		const noData = fills.filter((f) => f?.endsWith(',0.14)')).length;
		expect(fills.length - noData).toBe(2);
		expect(noData).toBeGreaterThan(100);
	});
});
