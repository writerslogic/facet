// The Experiments view renders a per-variant table with exposures / conversions / rate / p-value
// and a "significant" badge for the challenger variant when the mocked result is significant.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Experiments } from '../components/Experiments.js';

vi.mock('../hooks/experiments.js', () => ({
	useExperiments: () => ({
		data: {
			experiments: [
				{
					id: 'exp-1',
					site_id: 'site-1',
					name: 'CTA color',
					flag_key: 'cta',
					variants: [
						{ key: 'control', weight: 1 },
						{ key: 'blue', weight: 1 },
					],
					active: true,
					created_at: 0,
				},
			],
		},
	}),
	useExperimentResult: () => ({
		data: {
			variants: [
				{
					key: 'control',
					exposures: 1000,
					conversions: 100,
					rate: 0.1,
					p_value: null,
					significant: false,
				},
				{
					key: 'blue',
					exposures: 1000,
					conversions: 150,
					rate: 0.15,
					p_value: 0.0026,
					significant: true,
				},
			],
		},
	}),
}));

vi.mock('../hooks/funnels.js', () => ({
	useGoals: () => ({
		data: {
			goals: [
				{
					id: 'g1',
					site_id: 'site-1',
					name: 'Signups',
					type: 'event',
					match_value: 'signup',
					created_at: 0,
				},
			],
		},
	}),
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

describe('Experiments', () => {
	it('renders the variant table with stat columns and a significance badge', () => {
		render(
			withQuery(
				<Experiments apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />,
			),
		);
		expect(screen.getByText('Exposures')).toBeInTheDocument();
		expect(screen.getByText('Conversions')).toBeInTheDocument();
		expect(screen.getByText('p-value')).toBeInTheDocument();
		expect(screen.getByText('control')).toBeInTheDocument();
		expect(screen.getByText('blue')).toBeInTheDocument();
		expect(screen.getByText('significant')).toBeInTheDocument();
		expect(screen.getByText('0.0026')).toBeInTheDocument();
	});
});
