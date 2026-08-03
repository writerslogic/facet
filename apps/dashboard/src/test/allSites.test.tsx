// The all-sites roll-up: fan-out with per-site keys, row-level failure isolation, sorting, and the
// aggregation rules (pageviews/events sum; visitors is an upper bound and must say so).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllSites } from '../components/AllSites.js';
import { DashboardProvider } from '../state.js';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const SITE_C = '33333333-3333-4333-8333-333333333333';

const PROFILES = [
	{ id: 'p-a', label: 'Alpha', siteId: SITE_A, apiKey: 'clk_alpha' },
	{ id: 'p-b', label: 'Bravo', siteId: SITE_B, apiKey: 'clk_bravo' },
	{ id: 'p-c', label: 'Charlie', siteId: SITE_C, apiKey: 'clk_charlie' },
];

interface Totals {
	pageviews: number;
	visitors: number;
	events: number;
}

/** What the mock server does for one site: serve numbers, reject, or fail the connection. */
type Behaviour =
	| { kind: 'ok'; current: Totals; previous: Totals }
	| { kind: 'reject'; error: string }
	| { kind: 'network' };

function statsBody(totals: Totals) {
	return {
		summary: totals,
		series: [
			{ t: 1_000, pageviews: Math.round(totals.pageviews / 2), visitors: 1 },
			{ t: 2_000, pageviews: Math.ceil(totals.pageviews / 2), visitors: 1 },
		],
		top_paths: [],
		top_referrers: [],
		top_events: [],
		top_countries: [],
		top_devices: [],
		engagement: { sessions: 0, bounce_rate: 0, pages_per_session: 0, avg_duration_ms: 0 },
		channels: [],
	};
}

const ok = (pageviews: number, visitors: number, events: number, prevPageviews = pageviews) =>
	({
		kind: 'ok',
		current: { pageviews, visitors, events },
		previous: { pageviews: prevPageviews, visitors, events },
	}) satisfies Behaviour;

interface RecordedCall {
	siteId: string;
	auth: string;
	current: boolean;
}

let calls: RecordedCall[] = [];

/** Install a fetch that answers per site id, recording the key each request was made with. */
function mockServer(behaviour: Record<string, Behaviour>): void {
	calls = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const params = new URLSearchParams(url.split('?')[1] ?? '');
			const siteId = params.get('site_id') ?? '';
			const headers = (init?.headers ?? {}) as Record<string, string>;
			// The comparison read asks for the preceding window, whose `end` is a whole range back.
			const current = Date.now() - Number(params.get('end')) < 60_000;
			calls.push({ siteId, auth: headers.Authorization ?? '', current });

			const site = behaviour[siteId];
			if (!site) throw new Error('unexpected site');
			if (site.kind === 'network') throw new Error('Failed to fetch');
			if (site.kind === 'reject') {
				return { ok: false, json: async () => ({ error: site.error }) };
			}
			return {
				ok: true,
				json: async () => statsBody(current ? site.current : site.previous),
			};
		}),
	);
}

function seed(profiles: typeof PROFILES): void {
	localStorage.setItem('facet.profiles', JSON.stringify(profiles));
	localStorage.setItem('facet.activeProfile', profiles[0]?.id ?? '');
}

function renderRollup() {
	const client = new QueryClient({
		// Row retries are exercised deliberately; a real backoff would just make the test slow.
		defaultOptions: { queries: { retryDelay: 0 } },
	});
	return render(
		<QueryClientProvider client={client}>
			<DashboardProvider>
				<AllSites />
			</DashboardProvider>
		</QueryClientProvider>,
	);
}

/** Site labels in the order they currently appear in the table body. */
function rowOrder(): string[] {
	return screen
		.getAllByRole('rowheader')
		.map((cell) => cell.querySelector('.truncate')?.textContent ?? '');
}

beforeEach(() => {
	localStorage.clear();
	window.history.replaceState(null, '', '/');
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('all-sites fan-out', () => {
	it('issues one request per profile using that profile’s own key', async () => {
		seed(PROFILES);
		mockServer({
			[SITE_A]: ok(1000, 400, 50),
			[SITE_B]: ok(300, 120, 10),
			[SITE_C]: ok(2000, 900, 5),
		});
		renderRollup();

		await waitFor(() => expect(screen.getByText('2,000')).toBeInTheDocument());
		// Every site is present with its own numbers — no switching required.
		expect(screen.getByText('Alpha')).toBeInTheDocument();
		expect(screen.getByText('1,000')).toBeInTheDocument();
		expect(screen.getByText('300')).toBeInTheDocument();

		// Current + comparison window per site, and never a key belonging to another site: a key is
		// bound to one site, so a cross-wired request would come back `site_mismatch`.
		const expected: Record<string, string> = {
			[SITE_A]: 'Bearer clk_alpha',
			[SITE_B]: 'Bearer clk_bravo',
			[SITE_C]: 'Bearer clk_charlie',
		};
		expect(calls).toHaveLength(6);
		for (const call of calls) expect(call.auth).toBe(expected[call.siteId]);
		for (const siteId of [SITE_A, SITE_B, SITE_C]) {
			const forSite = calls.filter((c) => c.siteId === siteId);
			expect(forSite.filter((c) => c.current)).toHaveLength(1);
			expect(forSite.filter((c) => !c.current)).toHaveLength(1);
		}
	});

	it('never renders an API key', async () => {
		seed(PROFILES);
		mockServer({
			[SITE_A]: ok(1000, 400, 50),
			[SITE_B]: ok(300, 120, 10),
			[SITE_C]: ok(2000, 900, 5),
		});
		const { container } = renderRollup();
		await waitFor(() => expect(screen.getByText('2,000')).toBeInTheDocument());
		expect(container.textContent).not.toContain('clk_');
	});

	it('shows a period-over-period delta per site', async () => {
		seed([PROFILES[0] as (typeof PROFILES)[number], PROFILES[1] as (typeof PROFILES)[number]]);
		mockServer({
			[SITE_A]: ok(1000, 400, 50, 500),
			[SITE_B]: ok(300, 120, 10, 300),
		});
		renderRollup();
		await waitFor(() => expect(screen.getByText('1,000')).toBeInTheDocument());
		// Alpha doubled its pageviews against the preceding window of equal length.
		expect(screen.getAllByText('+100%').length).toBeGreaterThan(0);
	});
});

describe('per-site failure isolation', () => {
	it('confines a network failure to its own row and offers a retry', async () => {
		seed(PROFILES);
		mockServer({
			[SITE_A]: ok(1000, 400, 50),
			[SITE_B]: { kind: 'network' },
			[SITE_C]: ok(2000, 900, 5),
		});
		renderRollup();

		await waitFor(() => expect(screen.getByText('Could not load Bravo')).toBeInTheDocument());
		// The other two sites are entirely unaffected.
		expect(screen.getByText('1,000')).toBeInTheDocument();
		expect(screen.getByText('2,000')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
		// And the aggregate admits it is partial rather than quietly under-reporting.
		expect(screen.getByText(/cover 2 of 3 sites/)).toBeInTheDocument();
	});

	it('recovers a failed row on retry without disturbing the others', async () => {
		seed(PROFILES);
		mockServer({
			[SITE_A]: ok(1000, 400, 50),
			[SITE_B]: { kind: 'network' },
			[SITE_C]: ok(2000, 900, 5),
		});
		renderRollup();
		await waitFor(() => expect(screen.getByText('Could not load Bravo')).toBeInTheDocument());

		// The site comes back (key reinstated / network restored), then the row is retried alone.
		mockServer({
			[SITE_A]: ok(1000, 400, 50),
			[SITE_B]: ok(300, 120, 10),
			[SITE_C]: ok(2000, 900, 5),
		});
		fireEvent.click(screen.getByRole('button', { name: /Retry/ }));

		await waitFor(() => expect(screen.getByText('300')).toBeInTheDocument());
		expect(screen.queryByText('Could not load Bravo')).not.toBeInTheDocument();
		// Only the retried site was re-requested.
		expect(calls.every((c) => c.siteId === SITE_B)).toBe(true);
		expect(screen.getByText('1,000')).toBeInTheDocument();
		expect(screen.getByText('2,000')).toBeInTheDocument();
	});

	it('shows the key-not-recognized banner for a revoked key, not a generic error', async () => {
		seed(PROFILES);
		mockServer({
			[SITE_A]: ok(1000, 400, 50),
			[SITE_B]: { kind: 'reject', error: 'invalid_api_key' },
			[SITE_C]: ok(2000, 900, 5),
		});
		renderRollup();

		await waitFor(() => expect(screen.getByText('API key not recognized')).toBeInTheDocument());
		expect(screen.getByText('1,000')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
	});
});

describe('aggregation honesty', () => {
	it('sums pageviews and events but labels the visitors figure an upper bound', async () => {
		seed(PROFILES);
		mockServer({
			[SITE_A]: ok(1000, 400, 50),
			[SITE_B]: ok(300, 120, 10),
			[SITE_C]: ok(2000, 900, 5),
		});
		renderRollup();

		await waitFor(() => expect(screen.getByText('3,300')).toBeInTheDocument());
		// Events sum exactly too.
		expect(screen.getByText('65')).toBeInTheDocument();
		// Visitors is never presented as a total. The bound is stated twice — on the card itself and
		// again in the footnote — and the naked sum (1,420) never appears without its ≤.
		expect(screen.getAllByText('≤ 1,420')).toHaveLength(2);
		expect(screen.queryByText('1,420')).not.toBeInTheDocument();
		expect(screen.getByText('Visitors · upper bound')).toBeInTheDocument();
		expect(screen.getByText(/counted twice/i)).toBeInTheDocument();
		expect(screen.getByText(/upper bound on people, not a total/i)).toBeInTheDocument();
		expect(screen.queryByText('Visitors · all sites')).not.toBeInTheDocument();
	});
});

describe('sorting', () => {
	it('orders rows by any column and reverses on a second click', async () => {
		seed(PROFILES);
		mockServer({
			[SITE_A]: ok(1000, 400, 50),
			[SITE_B]: ok(300, 120, 10),
			[SITE_C]: ok(2000, 900, 5),
		});
		renderRollup();
		await waitFor(() => expect(screen.getByText('2,000')).toBeInTheDocument());

		// Default: biggest pageviews first.
		expect(rowOrder()).toEqual(['Charlie', 'Alpha', 'Bravo']);

		const table = screen.getByRole('table');
		fireEvent.click(within(table).getByRole('button', { name: /Pageviews/ }));
		expect(rowOrder()).toEqual(['Bravo', 'Alpha', 'Charlie']);

		// Events ranks them differently, which is the whole point of a sortable roll-up.
		fireEvent.click(within(table).getByRole('button', { name: /Events/ }));
		expect(rowOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);

		fireEvent.click(within(table).getByRole('button', { name: /Site/ }));
		expect(rowOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);
	});

	it('keeps a failed row at the bottom in both directions', async () => {
		seed(PROFILES);
		mockServer({
			[SITE_A]: ok(1000, 400, 50),
			[SITE_B]: { kind: 'network' },
			[SITE_C]: ok(2000, 900, 5),
		});
		renderRollup();
		await waitFor(() => expect(screen.getByText('Could not load Bravo')).toBeInTheDocument());

		// A row with no number must not sort as if it were zero — ascending would otherwise put the
		// broken site first and read as "fewest pageviews".
		expect(rowOrder()).toEqual(['Charlie', 'Alpha', 'Bravo']);
		fireEvent.click(
			within(screen.getByRole('table')).getByRole('button', { name: /Pageviews/ }),
		);
		expect(rowOrder()).toEqual(['Alpha', 'Charlie', 'Bravo']);
	});
});

describe('empty and single-site states', () => {
	it('points at adding a site when no profiles are saved', () => {
		mockServer({});
		renderRollup();
		expect(screen.getByText('No sites saved')).toBeInTheDocument();
		expect(screen.getByText(/come back here to compare/i)).toBeInTheDocument();
		expect(screen.queryByRole('table')).not.toBeInTheDocument();
	});

	it('stays coherent with one site and nudges towards adding a second', async () => {
		seed([PROFILES[0] as (typeof PROFILES)[number]]);
		mockServer({ [SITE_A]: ok(1000, 400, 50) });
		renderRollup();

		await waitFor(() => expect(screen.getByText('1,000')).toBeInTheDocument());
		// The site's own row is still fully rendered…
		expect(screen.getByText('Alpha')).toBeInTheDocument();
		expect(screen.getByRole('table')).toBeInTheDocument();
		// …but an "all sites" aggregate over exactly one site would just repeat the row, so it is not
		// shown; the space carries the next step instead.
		expect(screen.queryByText('Pageviews · all sites')).not.toBeInTheDocument();
		expect(screen.getByText(/nothing to compare it against yet/i)).toBeInTheDocument();
	});
});
