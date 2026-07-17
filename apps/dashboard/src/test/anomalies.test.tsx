// The Anomalies view renders the plain-language autopsy summary for a detected anomaly, and the
// empty state when nothing is flagged.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Anomalies } from '../components/Anomalies.js';

const { useAnomaliesMock } = vi.hoisted(() => ({ useAnomaliesMock: vi.fn() }));

vi.mock('../hooks/anomaly.js', () => ({
	useAnomalies: useAnomaliesMock,
}));

function withQuery(ui: ReactElement): ReactElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('Anomalies', () => {
	it('renders the autopsy summary for a detected anomaly', () => {
		useAnomaliesMock.mockReturnValue({
			data: {
				anomalies: [
					{
						metric: 'pageviews',
						bucket: 0,
						value: 1,
						baseline_mean: 10,
						z: -3.5,
						direction: 'drop',
						diagnosis: {
							dimension: 'device',
							value: 'mobile',
							current: 0,
							baseline_avg: 8,
						},
						summary:
							'Pageviews dropped 90% in the last hour (z=-3.5). Largest contributor: device=mobile (0 vs ~8 typical).',
					},
				],
			},
		});
		render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		expect(screen.getByText(/Pageviews dropped 90%/)).toBeInTheDocument();
	});

	it('renders the empty state for no anomalies', () => {
		useAnomaliesMock.mockReturnValue({ data: { anomalies: [] } });
		render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		expect(screen.getByText('No anomalies detected')).toBeInTheDocument();
	});
});
