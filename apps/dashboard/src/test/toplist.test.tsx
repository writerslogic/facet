import type { CountRow } from '@countless/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TopList } from '../components/TopList.js';

describe('TopList', () => {
	it('renders one row per CountRow with proportional bar widths', () => {
		const rows: CountRow[] = [
			{ key: '/home', count: 100 },
			{ key: '/about', count: 25 },
		];
		render(<TopList title="Top Pages" rows={rows} />);

		expect(screen.getByText('/home')).toBeInTheDocument();
		expect(screen.getByText('/about')).toBeInTheDocument();

		const bars = screen.getAllByTestId('toplist-bar');
		expect(bars).toHaveLength(2);
		expect(bars[0]).toHaveStyle({ width: '100%' });
		expect(bars[1]).toHaveStyle({ width: '25%' });
	});

	it('renders an empty state for an empty list', () => {
		render(<TopList title="Top Pages" rows={[]} />);
		expect(screen.getByText('No data yet')).toBeInTheDocument();
		expect(screen.queryAllByTestId('toplist-bar')).toHaveLength(0);
	});
});
