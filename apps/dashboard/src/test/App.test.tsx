import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../App.js';
import { DashboardProvider } from '../state.js';

function renderApp() {
	const client = new QueryClient();
	return render(
		<QueryClientProvider client={client}>
			<DashboardProvider>
				<App />
			</DashboardProvider>
		</QueryClientProvider>,
	);
}

describe('App', () => {
	it('renders the Facet heading', () => {
		renderApp();
		expect(screen.getByRole('heading', { name: 'Facet' })).toBeInTheDocument();
	});
});
