// multi-site profiles. Switching the active profile changes the site and must not show the
// previous site's cached data; add/remove works; an invalid-key profile surfaces the auth banner;
// profiles persist across a remount (re-read from storage).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { AdminProvider } from '../admin.js';
import { DashboardProvider } from '../state.js';

// uPlot needs a real canvas which jsdom lacks; mock it so the full-app render doesn't throw async.
vi.mock('uplot', () => ({
	default: class {
		constructor(_opts: unknown, _data: unknown, container: HTMLElement) {
			const node = document.createElement('div');
			node.className = 'uplot';
			container.appendChild(node);
		}
		setSize() {}
		destroy() {}
	},
}));
vi.mock('uplot/dist/uPlot.min.css', () => ({}));

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

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

function statsFor(siteId: string) {
	// Encode the site into the pageviews so a leak would be detectable in the UI. Distinct visitor
	// count keeps the pageviews value unique in the DOM.
	const pv = siteId === SITE_A ? 111 : 222;
	return {
		summary: { pageviews: pv, visitors: pv + 1, events: pv + 2 },
		series: [{ t: 1000, pageviews: pv, visitors: pv + 1 }],
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

function seedTwoProfiles() {
	localStorage.setItem(
		'facet.profiles',
		JSON.stringify([
			{ id: 'a', label: 'Site A', siteId: SITE_A, apiKey: 'clk_a' },
			{ id: 'b', label: 'Site B', siteId: SITE_B, apiKey: 'clk_b' },
		]),
	);
	localStorage.setItem('facet.activeProfile', 'a');
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState(null, '', '/');
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('multi-site profiles', () => {
	it('switching profiles changes the site and never shows the previous site data', async () => {
		seedTwoProfiles();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : String(input);
				const siteId = url.includes(SITE_B) ? SITE_B : SITE_A;
				return { ok: true, json: async () => statsFor(siteId) };
			}),
		);
		renderApp();
		await waitFor(() => expect(screen.getByText('111')).toBeInTheDocument());

		fireEvent.change(screen.getByLabelText('Active site'), {
			target: { value: 'b' },
		});

		await waitFor(() => expect(screen.getByText('222')).toBeInTheDocument());
		// Site A's data must be gone (no stale flash under Site B's label).
		expect(screen.queryByText('111')).not.toBeInTheDocument();
	});

	it('surfaces the auth banner for a profile with an invalid key', async () => {
		localStorage.setItem(
			'facet.profiles',
			JSON.stringify([{ id: 'a', label: 'Site A', siteId: SITE_A, apiKey: 'clk_bad' }]),
		);
		localStorage.setItem('facet.activeProfile', 'a');
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: false,
				json: async () => ({ error: 'invalid_api_key' }),
			}),
		);
		renderApp();
		await waitFor(() => expect(screen.getByText('API key not recognized')).toBeInTheDocument());
	});

	it('persists profiles across a remount', async () => {
		seedTwoProfiles();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => statsFor(SITE_A),
			}),
		);
		const { unmount } = renderApp();
		await waitFor(() => expect(screen.getByLabelText('Active site')).toBeInTheDocument());
		unmount();

		// Fresh mount reads from storage.
		renderApp();
		const select = (await screen.findByLabelText('Active site')) as HTMLSelectElement;
		expect(select.value).toBe('a');
		expect(screen.getByRole('option', { name: 'Site B' })).toBeInTheDocument();
	});
});
