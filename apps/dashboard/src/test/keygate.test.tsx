import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { DashboardProvider, rangeForPreset } from '../state.js';

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

beforeEach(() => {
	localStorage.clear();
	window.history.replaceState(null, '', '/');
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				summary: { pageviews: 0, visitors: 0, events: 0 },
				series: [],
				top_paths: [],
				top_referrers: [],
				top_events: [],
				top_countries: [],
				top_devices: [],
			}),
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('KeyGate', () => {
	it('gates until key + site are entered, then persists and shows the shell', async () => {
		renderApp();

		expect(screen.getByText('View dashboard')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('cl_live_…'), {
			target: { value: 'my-key' },
		});
		fireEvent.change(screen.getByPlaceholderText('example.com'), {
			target: { value: 'example.com' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'View dashboard' }));

		expect(localStorage.getItem('countless.key')).toBe('my-key');
		expect(localStorage.getItem('countless.site')).toBe('example.com');

		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument(),
		);
	});

	it('switching the range preset updates the derived window', async () => {
		localStorage.setItem('countless.key', 'my-key');
		localStorage.setItem('countless.site', 'example.com');
		renderApp();

		await waitFor(() =>
			expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument(),
		);
		fireEvent.click(screen.getByRole('button', { name: '30d' }));

		expect(new URLSearchParams(window.location.search).get('range')).toBe('30d');

		const window30 = rangeForPreset('30d');
		const window7 = rangeForPreset('7d');
		expect(window30.start).toBeLessThan(window7.start);
	});
});
