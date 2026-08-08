// Settings admin area. Entering an admin token enables Settings; create refreshes the list;
// delete confirms then removes; the admin token lives in sessionStorage (never localStorage) and
// never appears in a non-admin request; "forget token" clears it. The gate verifies the token with
// the deployment before storing it, and a freshly issued API key is scoped to the site it was issued
// for and never persisted unless the operator explicitly asks for it.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
/** Flip to make every admin call fail auth, as a rotated ADMIN_TOKEN would. */
let adminAuthFails = false;
/** Plaintext returned by POST /api/keys. Only ever shown once; never persisted by the panel. */
const ISSUED_KEY = 'clk_plaintext_secret_value';

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

/** Every value in both web storages, so a secret can be asserted absent from all of them. */
function allStoredValues(): string {
	const values: string[] = [];
	for (const store of [localStorage, sessionStorage]) {
		for (let i = 0; i < store.length; i++) {
			values.push(store.getItem(store.key(i) ?? '') ?? '');
		}
	}
	return values.join('|');
}

function seedProfile() {
	localStorage.setItem(
		'facet.profiles',
		JSON.stringify([{ id: 'p1', label: 'Prod', siteId: VALID_SITE, apiKey: 'clk_x' }]),
	);
	sessionStorage.setItem('facet.activeProfile', 'p1');
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

		if (adminAuthFails && /^\/api\/(sites|keys|goals|funnels|experiments|flags)/.test(url)) {
			return {
				ok: false,
				status: 401,
				json: async () => ({ error: 'invalid_admin_token' }),
			};
		}
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
		if (url.startsWith('/api/keys')) {
			if (init?.method === 'POST') {
				return { ok: true, json: async () => ({ id: 'key-1', key: ISSUED_KEY }) };
			}
			return { ok: true, json: async () => ({ keys: [] }) };
		}
		if (url.startsWith('/api/goals')) return { ok: true, json: async () => ({ goals: [] }) };
		if (url.startsWith('/api/funnels'))
			return { ok: true, json: async () => ({ funnels: [] }) };
		if (url.startsWith('/api/experiments'))
			return { ok: true, json: async () => ({ experiments: [] }) };
		if (url.startsWith('/api/flags')) return { ok: true, json: async () => ({ flags: [] }) };
		return { ok: true, json: async () => emptyStats };
	});
}

/**
 * Warm App's lazy Settings boundary once, outside any test.
 *
 * Settings is code-split (`lazy(() => import('./components/Settings.js'))`), so the FIRST render
 * that reaches it suspends and commits `TabFallback`. React then throttles revealing the resolved
 * content — `SUSPENSE_FALLBACK_THROTTLE_MS`, a fixed 300ms — on top of the chunk's own load time.
 * All of that is charged to `findByLabelText('Admin token')` inside `openSettingsWithToken`, whose
 * budget is RTL's default 1000ms. Measured: whichever test ran first took 390–950ms (305ms of it
 * inside that one `findBy`) while every later test took 30–60ms, because by then `lazy` has a
 * resolved payload and never suspends again. That is the flake: one test in this file sits at ~2x
 * headroom on a 1000ms budget, and under full-suite parallelism it loses.
 *
 * Warming it here pays the same cost once, in a hook with a 5000ms budget, and leaves every test
 * asserting on a boundary that no longer suspends. No assertion or timeout is changed.
 */
beforeAll(async () => {
	seedProfile();
	vi.stubGlobal('fetch', mockFetch());
	renderApp();
	fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
	await screen.findByLabelText('Admin token');
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	calls = [];
});

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState(null, '', '/');
	calls = [];
	sites = [];
	adminAuthFails = false;
	seedProfile();
	vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function openSettingsWithToken() {
	renderApp();
	fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
	// Prompted for the admin token (Settings is code-split, so await its lazy chunk).
	expect(await screen.findByLabelText('Admin token')).toBeInTheDocument();
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
			// Mirrors ADMIN_PATHS in admin.ts. `users` covers /api/users/:id/revoke-sessions.
			const isAdmin = /^\/api\/(sites|keys|goals|funnels|experiments|flags|users)/.test(
				call.url,
			);
			if (!isAdmin) {
				// Coalesced because the session routes (`/api/auth/me`) send NO Authorization header
				// at all, which is the strongest possible pass and the shape this used to throw on.
				expect(call.auth ?? '').not.toContain(ADMIN_TOKEN);
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
		await waitFor(() => expect(panel.getByText('My blog')).toBeInTheDocument());
		// The new site is selected straight away, and the context bar says which one is managed.
		expect(panel.getByRole('button', { name: 'Managing' })).toBeInTheDocument();
		expect(screen.getByText('Managing site')).toBeInTheDocument();
	});

	it('forgets the admin token', async () => {
		await openSettingsWithToken();
		fireEvent.click(screen.getByRole('button', { name: 'Forget admin token' }));
		await waitFor(() => expect(screen.getByLabelText('Admin token')).toBeInTheDocument());
		expect(sessionStorage.getItem('facet.adminToken')).toBeNull();
	});

	it('states that the token is deployment-wide before it is entered', async () => {
		renderApp();
		fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
		expect(await screen.findByLabelText('Admin token')).toBeInTheDocument();
		expect(screen.getByText(/deployment-wide/i)).toBeInTheDocument();
		expect(screen.getByText(/every site/i)).toBeInTheDocument();
		expect(screen.getByText(/wrangler secret put ADMIN_TOKEN/)).toBeInTheDocument();
	});

	it('rejects an unverified token at the gate and stores nothing', async () => {
		adminAuthFails = true;
		renderApp();
		fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
		fireEvent.change(await screen.findByLabelText('Admin token'), {
			target: { value: 'wrong-token' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Enter admin' }));

		await waitFor(() => expect(screen.getByText(/token was rejected/i)).toBeInTheDocument());
		// A token the deployment refused must never reach storage, and the gate must stay up.
		expect(sessionStorage.getItem('facet.adminToken')).toBeNull();
		expect(screen.getByLabelText('Admin token')).toBeInTheDocument();
		expect(screen.queryByText('Admin session active')).not.toBeInTheDocument();
	});

	it('switches sections without leaving the admin area', async () => {
		await openSettingsWithToken();
		fireEvent.click(screen.getByRole('tab', { name: 'Goals' }));
		expect(await screen.findByRole('heading', { name: 'Goals' })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'API keys' })).not.toBeInTheDocument();
		// Sites stays pinned above the tabs so the managed site is never out of reach.
		expect(screen.getByRole('heading', { name: 'Sites' })).toBeInTheDocument();
	});

	it('drops the one-time key when the managed site changes, and never persists it', async () => {
		sites = [
			{ id: VALID_SITE, name: 'Site A', domain: 'a.example', created_at: 2 },
			{ id: 'site-b', name: 'Site B', domain: 'b.example', created_at: 1 },
		];
		await openSettingsWithToken();
		await waitFor(() => expect(screen.getByText('Site B')).toBeInTheDocument());

		fireEvent.click(screen.getByRole('button', { name: 'Issue key' }));
		await waitFor(() => expect(screen.getByText(ISSUED_KEY)).toBeInTheDocument());

		// Showing the plaintext must not write it anywhere — only "Save in this browser" does that.
		expect(allStoredValues()).not.toContain(ISSUED_KEY);

		// Site B's row is the second "Manage" button; switching must discard site A's key rather
		// than leave it on screen to be saved against the wrong site id.
		const manage = screen.getAllByRole('button', { name: 'Manage' });
		const last = manage[manage.length - 1];
		if (!last) throw new Error('no site to switch to');
		fireEvent.click(last);
		await waitFor(() => expect(screen.queryByText(ISSUED_KEY)).not.toBeInTheDocument());
	});

	it('flags a rotated token once instead of failing panel by panel', async () => {
		// A token accepted at unlock, then rotated on the deployment: every panel would otherwise
		// show its own bare "invalid_admin_token" with no hint of the shared cause.
		sessionStorage.setItem('facet.adminToken', ADMIN_TOKEN);
		adminAuthFails = true;
		renderApp();
		fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
		await waitFor(() =>
			expect(screen.getByText(/rejected this admin token/i)).toBeInTheDocument(),
		);
	});
});
