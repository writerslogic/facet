// The Ask panel renders the answer line and a breakdown (via TopList) from a mocked NL query result.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskPanel } from '../components/AskPanel.js';

vi.mock('../hooks/query.js', () => ({
	useNlQuery: () => ({
		mutate: () => {},
		isPending: false,
		error: null,
		data: {
			intent: { metric: 'pageviews', dimension: 'country' },
			answer: 'Top country by pageviews: US (4), DE (2)',
			result: {
				kind: 'breakdown',
				rows: [
					{ key: 'US', count: 4 },
					{ key: 'DE', count: 2 },
				],
			},
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

describe('AskPanel', () => {
	it('renders the answer and breakdown rows', () => {
		render(
			withQuery(<AskPanel apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		expect(screen.getByText('Top country by pageviews: US (4), DE (2)')).toBeInTheDocument();
		expect(screen.getByText('US')).toBeInTheDocument();
		expect(screen.getByText('DE')).toBeInTheDocument();
		expect(screen.getByText('4')).toBeInTheDocument();
	});
});
