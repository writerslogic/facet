// T060: the funnel chart renders one bar per step (width proportional to the first step) with the
// overall rate, and the conversions list renders one row per goal.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Conversions } from '../components/Conversions.js';
import { FunnelChart } from '../components/FunnelChart.js';

function withQuery(ui: ReactElement): ReactElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

describe('FunnelChart', () => {
	it('renders one bar per step and the overall rate', () => {
		render(
			<FunnelChart
				report={{
					steps: [
						{ index: 0, match_value: '/', count: 100 },
						{ index: 1, match_value: '/pricing', count: 40 },
						{ index: 2, match_value: 'signup', count: 12 },
					],
					overall_rate: 0.12,
				}}
			/>,
		);
		expect(screen.getAllByTestId('funnel-bar')).toHaveLength(3);
		expect(screen.getByText('12%')).toBeInTheDocument();
		expect(screen.getByText('/pricing')).toBeInTheDocument();
	});
});

describe('Conversions', () => {
	it('renders one row per goal', () => {
		render(
			withQuery(
				<Conversions
					apiKey="clk_test"
					siteId="site-1"
					range={{ start: 0, end: 1 }}
					onOpenSettings={() => {}}
					goals={[
						{
							id: 'g1',
							site_id: 'site-1',
							name: 'Signups',
							type: 'event',
							match_value: 'signup',
							created_at: 0,
						},
					]}
				/>,
			),
		);
		expect(screen.getByText('Signups')).toBeInTheDocument();
	});
});
