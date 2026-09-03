import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { AdminProvider } from '../admin.js';
import { DashboardProvider, rangeForPreset } from '../state.js';

const VALID_SITE = '11111111-1111-4111-8111-111111111111';

function renderApp() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<DashboardProvider>
				<AdminProvider>
					<App />
				</AdminProvider>
			</DashboardProvider>
		</QueryClientProvider>,
	);
}

function okStats() {
	return {
		summary: { pageviews: 0, visitors: 0, events: 0 },
		series: [],
		top_paths: [],
		top_referrers: [],
		top_events: [],
		top_countries: [],
		top_devices: [],
		engagement: {
			sessions: 0,
			bounce_rate: 0,
			pages_per_session: 0,
			avg_duration_ms: 0,
		},
		channels: [],
	};
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState(null, '', '/');
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => okStats() }));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('KeyGate', () => {
	it('uses an API key only in memory while persisting non-secret site metadata', async () => {
		renderApp();
		expect(screen.getByText('View dashboard')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('clk_…'), {
			target: { value: 'clk_live_abc' },
		});
		fireEvent.change(screen.getByPlaceholderText('xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx'), {
			target: { value: VALID_SITE },
		});
		fireEvent.click(screen.getByRole('button', { name: 'View dashboard' }));

		const profiles = JSON.parse(sessionStorage.getItem('facet.profiles') ?? '[]');
		expect(profiles).toHaveLength(1);
		expect(profiles[0].apiKey).toBeUndefined();
		expect(profiles[0].siteId).toBe(VALID_SITE);
		expect(JSON.stringify(profiles)).not.toContain('clk_live_abc');

		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument(),
		);
	});

	it('blocks a malformed key or site with an inline message', () => {
		renderApp();

		fireEvent.change(screen.getByPlaceholderText('clk_…'), {
			target: { value: 'nope' },
		});
		fireEvent.change(screen.getByPlaceholderText('xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx'), {
			target: { value: 'not-a-uuid' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'View dashboard' }));

		expect(screen.getByText(/API key should start with/)).toBeInTheDocument();
		expect(screen.getByText(/Site ID should be a UUID/)).toBeInTheDocument();
		// Still on the gate; no profile created.
		expect(sessionStorage.getItem('facet.profiles')).toBeNull();
		expect(screen.getByText('View dashboard')).toBeInTheDocument();
	});

	it('scrubs legacy stored credentials while keeping them for the current document', async () => {
		localStorage.setItem('facet.key', 'clk_legacy');
		localStorage.setItem('facet.site', VALID_SITE);
		renderApp();

		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument(),
		);
		const profiles = JSON.parse(sessionStorage.getItem('facet.profiles') ?? '[]');
		expect(profiles).toHaveLength(1);
		expect(profiles[0].apiKey).toBeUndefined();
		expect(JSON.stringify(profiles)).not.toContain('clk_legacy');
		expect(localStorage.getItem('facet.key')).toBeNull();
	});

	it('hydrates team sites from an HttpOnly-cookie session without an API key', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === '/api/auth/me') {
					return {
						ok: true,
						json: async () => ({
							user: { id: 'u1', email: 'owner@example.com', name: null },
							memberships: [],
							sites: [
								{
									id: VALID_SITE,
									name: 'Session site',
									domain: 'example.com',
									role: 'owner',
								},
							],
						}),
					};
				}
				return { ok: true, json: async () => okStats() };
			}),
		);
		renderApp();
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument(),
		);
		const stored = sessionStorage.getItem('facet.profiles') ?? '';
		expect(stored).toContain('Session site');
		expect(stored).not.toContain('apiKey');
	});

	it('switching the range preset updates the derived window', async () => {
		localStorage.setItem(
			'facet.profiles',
			JSON.stringify([{ id: 'p1', label: 'x', siteId: VALID_SITE, apiKey: 'clk_x' }]),
		);
		sessionStorage.setItem('facet.activeProfile', 'p1');
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
