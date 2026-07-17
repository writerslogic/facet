import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KpiCards } from '../components/KpiCards.js';
describe('x', () => {
	it('renders 42', () => {
		render(
			<KpiCards
				summary={{ pageviews: 42, visitors: 10, events: 3 }}
				series={[{ t: 1000, pageviews: 42, visitors: 10 }]}
			/>,
		);
		expect(screen.getByText('42')).toBeInTheDocument();
	});
});
