import type { SeriesPoint } from '@countless/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// uPlot needs a real canvas which jsdom lacks. Mock it so we can assert the wrapper mounts a
// `.uplot` node fed with two series (pageviews + visitors) without a live canvas.
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

describe('KpiCards', () => {
	it('renders the three formatted KPI numbers', () => {
		render(<KpiCards summary={{ pageviews: 12345, visitors: 6789, events: 42 }} />);
		expect(screen.getByText('12,345')).toBeInTheDocument();
		expect(screen.getByText('6,789')).toBeInTheDocument();
		expect(screen.getByText('42')).toBeInTheDocument();
	});
});

describe('TrafficChart', () => {
	it('mounts a .uplot node fed with two series', () => {
		const series: SeriesPoint[] = [
			{ t: 1_700_000_000_000, pageviews: 10, visitors: 4 },
			{ t: 1_700_003_600_000, pageviews: 20, visitors: 9 },
		];
		const { container } = render(<TrafficChart series={series} />);

		expect(container.querySelector('.uplot')).not.toBeNull();

		const call = uplotCalls.at(-1);
		expect(call).toBeDefined();
		const data = call?.data as number[][];
		// [x, pageviews, visitors] => three rows, two of which are the series.
		expect(data).toHaveLength(3);
		expect(data[1]).toEqual([10, 20]);
		expect(data[2]).toEqual([4, 9]);
	});

	it('shows the empty state for an empty series', () => {
		render(<TrafficChart series={[]} />);
		expect(screen.getByText('No data yet')).toBeInTheDocument();
	});
});
