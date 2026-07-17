// C.9: Settings admin area. Entering an admin token enables Settings; create refreshes the list;
// delete confirms then removes; the admin token lives in sessionStorage (never localStorage) and
// never appears in a non-admin request; "forget token" clears it.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { AdminProvider } from '../admin.js';
import { DashboardProvider } from '../state.js';

const VALID_SITE = '11111111-1111-4111-8111-111111111111';
const ADMIN_TOKEN = 'admintoken-secret';

interface Call {
	url: string;
	auth: string | null;
}

let calls: Call[] = [];
let sites: { id: string; name: string; domain: string; created_at: number }[] = [];

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

function seedProfile() {
	localStorage.setItem(
		'facet.profiles',
		JSON.stringify([{ id: 'p1', label: 'Prod', siteId: VALID_SITE, apiKey: 'clk_x' }]),
	);
	localStorage.setItem('facet.activeProfile', 'p1');
}

const emptyStats = {
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

function mockFetch() {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String(input);
		const auth =
			init?.headers && typeof init.headers === 'object'
				? ((init.headers as Record<string, string>).Authorization ?? null)
				: null;
		calls.push({ url, auth });

		if (url.startsWith('/api/sites')) {
			if (init?.method === 'POST') {
				const body = JSON.parse(String(init.body));
				const site = {
					id: 'site-new',
					name: body.name,
					domain: body.domain,
					created_at: 1,
				};
				sites.push(site);
				return { ok: true, json: async () => ({ site }) };
			}
			return { ok: true, json: async () => ({ sites }) };
		}
		if (url.startsWith('/api/keys')) return { ok: true, json: async () => ({ keys: [] }) };
		if (url.startsWith('/api/goals')) return { ok: true, json: async () => ({ goals: [] }) };
		if (url.startsWith('/api/funnels'))
			return { ok: true, json: async () => ({ funnels: [] }) };
		if (url.startsWith('/api/experiments'))
			return { ok: true, json: async () => ({ experiments: [] }) };
		return { ok: true, json: async () => emptyStats };
	});
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState(null, '', '/');
	calls = [];
	sites = [];
	seedProfile();
	vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function openSettingsWithToken() {
	renderApp();
	fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
	// Prompted for the admin token.
	expect(screen.getByLabelText('Admin token')).toBeInTheDocument();
	fireEvent.change(screen.getByLabelText('Admin token'), {
		target: { value: ADMIN_TOKEN },
	});
	fireEvent.click(screen.getByRole('button', { name: 'Enter admin' }));
	await waitFor(() => expect(screen.getByText('Admin session active')).toBeInTheDocument());
}

describe('Settings admin area', () => {
	it('requires an admin token, then enables the panels', async () => {
		await openSettingsWithToken();
		expect(screen.getByRole('heading', { name: 'Sites' })).toBeInTheDocument();
	});

	it('stores the admin token in sessionStorage, never localStorage', async () => {
		await openSettingsWithToken();
		expect(sessionStorage.getItem('facet.adminToken')).toBe(ADMIN_TOKEN);
		// Not in localStorage under any key.
		const localValues: (string | null)[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			localValues.push(localStorage.getItem(localStorage.key(i) ?? ''));
		}
		expect(localValues).not.toContain(ADMIN_TOKEN);
		expect(localStorage.getItem('facet.adminToken')).toBeNull();
	});

	it('never sends the admin token to a non-admin request URL or header', async () => {
		await openSettingsWithToken();
		await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/sites'))).toBe(true));
		for (const call of calls) {
			const isAdmin = /^\/api\/(sites|keys|goals|funnels|experiments)/.test(call.url);
			if (!isAdmin) {
				expect(call.auth).not.toContain(ADMIN_TOKEN);
			}
			// The token is never in a URL/query string.
			expect(call.url).not.toContain(ADMIN_TOKEN);
		}
	});

	it('creates a site and refreshes the list without reload', async () => {
		await openSettingsWithToken();
		const sitesPanel = screen.getByRole('heading', { name: 'Sites' }).closest('section');
		if (!sitesPanel) throw new Error('sites panel missing');
		const panel = within(sitesPanel);
		fireEvent.change(panel.getByLabelText('Name'), {
			target: { value: 'My blog' },
		});
		fireEvent.change(panel.getByLabelText('Domain'), {
			target: { value: 'blog.example' },
		});
		fireEvent.click(panel.getByRole('button', { name: 'Create site' }));
		await waitFor(() => expect(screen.getByText('My blog')).toBeInTheDocument());
	});

	it('forgets the admin token', async () => {
		await openSettingsWithToken();
		fireEvent.click(screen.getByRole('button', { name: 'Forget admin token' }));
		await waitFor(() => expect(screen.getByLabelText('Admin token')).toBeInTheDocument());
		expect(sessionStorage.getItem('facet.adminToken')).toBeNull();
	});
});
