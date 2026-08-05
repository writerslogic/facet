// The shared segment: the value model, the URL codec, and — the part that matters most — a guard
// that every "this tab cannot filter" claim is still TRUE of the server.
//
// The failure this file exists for: someone teaches `cohortRetention` (or the anomaly detector, or
// the funnel report) to honour a dimension filter, the tab keeps rendering "cannot apply the active
// segment", and a reader is told the numbers are site-wide when they are not — the same class of
// lie, just pointing the other way. So the capability table is pinned to the server SQL rather than
// hand-maintained, in the spirit of docDrift.test.tsx.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { AdminProvider } from '../admin.js';
import { SegmentBar, SegmentNotice } from '../components/CubeFilterBar.js';
import { SegmentProvider } from '../hooks/segment.js';
import {
	EMPTY_SEGMENT,
	SEGMENT_KEYS,
	type Segment,
	TAB_SEGMENT_SUPPORT,
	isSegmentActive,
	readSegmentFromUrl,
	segmentEntries,
	segmentParams,
	segmentReducer,
	toCubeFilter,
	toServerFilter,
	writeSegmentToUrl,
} from '../lib/segment.js';
import { DashboardProvider } from '../state.js';
import { blockAfter, pathOf, readSource } from './sourceOfTruth.js';

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

const VALID_SITE = '11111111-1111-4111-8111-111111111111';

describe('segment reducer', () => {
	it('toggles a dimension on, then off again with the same value', () => {
		const on = segmentReducer(EMPTY_SEGMENT, {
			type: 'toggle',
			key: 'device',
			value: 'mobile',
		});
		expect(on).toEqual({ device: 'mobile' });
		expect(segmentReducer(on, { type: 'toggle', key: 'device', value: 'mobile' })).toEqual({});
	});

	it('replaces a different value on the same axis rather than accumulating', () => {
		const first = { device: 'mobile' };
		expect(segmentReducer(first, { type: 'toggle', key: 'device', value: 'desktop' })).toEqual({
			device: 'desktop',
		});
	});

	it('set replaces the whole segment, dropping axes not named (the Investigate contract)', () => {
		const before: Segment = { path: '/pricing', device: 'mobile' };
		expect(segmentReducer(before, { type: 'set', segment: { country: 'US' } })).toEqual({
			country: 'US',
		});
	});

	it('remove drops one axis and clear drops all of them', () => {
		const both: Segment = { device: 'mobile', country: 'US' };
		expect(segmentReducer(both, { type: 'remove', key: 'device' })).toEqual({ country: 'US' });
		expect(segmentReducer(both, { type: 'clear' })).toEqual({});
	});

	it('returns the same object identity when a transition changes nothing', () => {
		const state: Segment = { device: 'mobile' };
		expect(segmentReducer(state, { type: 'remove', key: 'country' })).toBe(state);
		expect(segmentReducer(state, { type: 'set', segment: { device: 'mobile' } })).toBe(state);
		expect(segmentReducer(EMPTY_SEGMENT, { type: 'clear' })).toBe(EMPTY_SEGMENT);
	});

	it('projects onto the cube axes and the server axes without overlap', () => {
		const segment: Segment = {
			device: 'mobile',
			country: 'US',
			channel: 'direct',
			path: '/pricing',
			referrer: 'r',
		};
		expect(toCubeFilter(segment)).toEqual({
			device: 'mobile',
			country: 'US',
			channel: 'direct',
		});
		expect(toServerFilter(segment)).toEqual({ path: '/pricing', referrer: 'r' });
		expect(segmentParams({ device: 'mobile', country: undefined })).toEqual({
			device: 'mobile',
		});
		expect(isSegmentActive({})).toBe(false);
		expect(segmentEntries(segment).map((e) => e.key)).toEqual([...SEGMENT_KEYS]);
	});
});

describe('segment URL codec', () => {
	beforeEach(() => {
		window.history.replaceState(null, '', '/');
	});

	it('round-trips every dimension through the querystring', () => {
		const segment: Segment = { device: 'mobile', country: 'US', path: '/pricing' };
		writeSegmentToUrl(segment);
		expect(readSegmentFromUrl(window.location.search)).toEqual(segment);
	});

	it('leaves the range params written by state.ts untouched', () => {
		window.history.replaceState(null, '', '/?range=custom&start=1&end=2');
		writeSegmentToUrl({ device: 'mobile' });
		const params = new URLSearchParams(window.location.search);
		expect(params.get('range')).toBe('custom');
		expect(params.get('start')).toBe('1');
		expect(params.get('device')).toBe('mobile');
	});

	it('deletes its own params when the segment is cleared', () => {
		window.history.replaceState(null, '', '/?range=7d&device=mobile&path=%2Fpricing');
		writeSegmentToUrl({});
		expect(window.location.search).toBe('?range=7d');
	});

	// A URL is untrusted input, and an over-long value 400s every read on the board rather than
	// filtering anything — so it is dropped before it can reach a query.
	it('drops empty and over-long values instead of forwarding them to the API', () => {
		const long = 'x'.repeat(9);
		expect(readSegmentFromUrl(`?country=${long}&device=&channel=direct`)).toEqual({
			channel: 'direct',
		});
	});
});

// -------------------------------------------------------------------------------------------
// The honesty table, pinned to the server.

describe('segment capability claims match the server', () => {
	it('covers every data tab', () => {
		expect(Object.keys(TAB_SEGMENT_SUPPORT).sort()).toEqual([
			'anomalies',
			'ask',
			'crm',
			'experiments',
			'funnels',
			'overview',
			'realtime',
			'retention',
		]);
	});

	it('Overview claims full support, and /api/stats really applies all five dimensions', () => {
		expect(TAB_SEGMENT_SUPPORT.overview.level).toBe('full');
		const where = blockAfter('statsSql', 'function buildFilteredEventWhere');
		for (const key of SEGMENT_KEYS) {
			expect(
				where.includes(`f.${key} !== undefined`),
				`buildFilteredEventWhere no longer narrows on \`${key}\` (${pathOf('statsSql')}), so the Overview's "full" claim in lib/segment.ts is stale`,
			).toBe(true);
		}
	});

	it('Retention claims none, because cohortRetention still ignores the dimension filters', () => {
		expect(TAB_SEGMENT_SUPPORT.retention.level).toBe('none');
		const body = blockAfter('statsSql', 'export async function cohortRetention');
		expect(
			body.includes('buildFilteredEventWhere'),
			`cohortRetention now applies the dimension filters (${pathOf('statsSql')}); Retention must stop saying it cannot`,
		).toBe(false);
		// It scopes by site + first-seen window only — that is WHY the tab cannot honour a segment.
		expect(body).toContain('schema.sessions.siteId');
	});

	it('Anomalies claims none, because detection still uses the unfiltered event predicate', () => {
		expect(TAB_SEGMENT_SUPPORT.anomalies.level).toBe('none');
		const src = readSource('anomalySql');
		expect(
			src.includes('buildFilteredEventWhere'),
			`detectAnomalies now narrows by dimension (${pathOf('anomalySql')}); Anomalies must stop saying it cannot`,
		).toBe(false);
		expect(src).toContain('buildEventWhere');
	});

	it('Funnels claims none, because the report route takes no dimension parameters', () => {
		expect(TAB_SEGMENT_SUPPORT.funnels.level).toBe('none');
		const report = blockAfter('funnelRoutes', "funnelsRoutes.get('/:id/report'");
		for (const key of SEGMENT_KEYS) {
			expect(
				report.includes(`c.req.query('${key}')`),
				`the funnel report now reads \`${key}\` (${pathOf('funnelRoutes')}); Funnels must stop saying it cannot filter`,
			).toBe(false);
		}
	});

	it('Experiments and Ask claim none, because neither handler builds a dimension filter', () => {
		expect(TAB_SEGMENT_SUPPORT.experiments.level).toBe('none');
		expect(TAB_SEGMENT_SUPPORT.ask.level).toBe('none');
		// Both hand the executor a bare { siteId, start, end }.
		const experiment = blockAfter('statsRoutes', "statsRoutes.get('/stats/experiment'");
		expect(experiment).toContain('{ siteId, start, end }');
		const ask = blockAfter('statsRoutes', "statsRoutes.post('/stats/query'");
		expect(ask).toContain('const f = { siteId, start, end };');
	});

	it('Realtime claims partial: the snapshot endpoint is site-scoped only', () => {
		expect(TAB_SEGMENT_SUPPORT.realtime.level).toBe('partial');
		const route = blockAfter('statsRoutes', "statsRoutes.get('/stats/realtime'");
		// No schema validation, no filter — just site_id and the trailing window.
		expect(route).not.toContain('toStatsFilter');
		// The half that CAN filter goes through /api/stats, which the hook builds a StatsQuery for.
		expect(readSource('dashboardRealtime')).toContain('segmentParams(segment)');
	});
});

// -------------------------------------------------------------------------------------------
// The surfaces

function withSegment(ui: ReactNode, segment: Segment): ReactElement {
	const search = new URLSearchParams(segment as Record<string, string>).toString();
	window.history.replaceState(null, '', search ? `/?${search}` : '/');
	return <SegmentProvider>{ui}</SegmentProvider>;
}

describe('segment surfaces', () => {
	beforeEach(() => {
		window.history.replaceState(null, '', '/');
	});

	it('says nothing at all when no segment is active', () => {
		render(
			withSegment(
				<>
					<SegmentBar />
					<SegmentNotice tab="retention" />
				</>,
				{},
			),
		);
		expect(screen.queryByText('Segment')).not.toBeInTheDocument();
		expect(screen.queryByRole('note')).not.toBeInTheDocument();
	});

	it('shows a removable chip per dimension plus one clear-all', () => {
		render(withSegment(<SegmentBar />, { device: 'mobile', path: '/pricing' }));
		expect(screen.getByText('mobile')).toBeInTheDocument();
		expect(screen.getByText('/pricing')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Remove Device filter'));
		expect(screen.queryByText('mobile')).not.toBeInTheDocument();
		expect(screen.getByText('/pricing')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
		expect(screen.queryByText('/pricing')).not.toBeInTheDocument();
	});

	it('declares loudly on a tab that cannot filter, and stays quiet on one that can', () => {
		const { unmount } = render(withSegment(<SegmentNotice tab="retention" />, { device: 'x' }));
		const note = screen.getByRole('note');
		expect(note).toHaveTextContent('This tab cannot apply the active segment.');
		expect(note.className).toContain('alert-warn');
		unmount();
		render(withSegment(<SegmentNotice tab="overview" />, { device: 'x' }));
		expect(screen.queryByRole('note')).not.toBeInTheDocument();
	});

	it('splits the claim on a partially-capable tab', () => {
		render(withSegment(<SegmentNotice tab="realtime" />, { device: 'x' }));
		expect(screen.getByRole('note')).toHaveTextContent(
			'This tab applies the active segment only in part.',
		);
	});

	// The value in a chip is the reader's own data (a path, a country) and has to survive Cmd+A;
	// the dimension label next to it is furniture.
	it('scopes chip text for selection: value selectable, label chrome', () => {
		const { container } = render(withSegment(<SegmentBar />, { path: '/pricing' }));
		expect(container.querySelector('[data-selectable]')).toHaveTextContent('/pricing');
		expect(container.querySelector('[data-chrome]')).toBeInTheDocument();
	});
});

// -------------------------------------------------------------------------------------------
// End to end: the segment follows the reader across tabs.

const emptyStats = {
	summary: { pageviews: 0, visitors: 0, events: 0 },
	series: [],
	top_paths: [],
	top_referrers: [],
	top_events: [],
	top_countries: [],
	top_devices: [],
	engagement: { sessions: 0, bounce_rate: 0, pages_per_session: 0, avg_duration_ms: 0 },
	channels: [],
};

function seedProfile(): void {
	localStorage.setItem(
		'facet.profiles',
		JSON.stringify([{ id: 'p1', label: 'Prod', siteId: VALID_SITE, apiKey: 'clk_x' }]),
	);
	localStorage.setItem('facet.activeProfile', 'p1');
}

/** Every URL the app requests, so a test can assert what the segment did (or did not) reach. */
let requested: string[] = [];

function mockApi(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			requested.push(String(url));
			const path = String(url);
			const body = path.includes('/api/stats/cube')
				? { interval: 'day', cells: [] }
				: path.includes('/api/stats/anomalies')
					? { anomalies: [] }
					: path.includes('/api/stats/retention')
						? { period: 'week', cohorts: [], note: 'n' }
						: path.includes('/api/stats/realtime')
							? { window_ms: 300000, visitors: 3, pageviews: 9, until: Date.now() }
							: emptyStats;
			return { ok: true, json: async () => body };
		}),
	);
}

function renderApp() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe('a segment follows the reader across tabs', () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		requested = [];
		seedProfile();
		mockApi();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		window.history.replaceState(null, '', '/');
	});

	it('survives a reload from the URL and stays visible on every tab', async () => {
		window.history.replaceState(null, '', '/?device=mobile');
		renderApp();
		// Overview owns the richer bar; the chip is the shared part.
		await waitFor(() => expect(screen.getAllByText('mobile').length).toBeGreaterThan(0));

		for (const tab of ['Retention', 'Funnels', 'Experiments', 'Anomalies', 'Ask']) {
			fireEvent.click(screen.getByRole('tab', { name: tab }));
			await waitFor(() => expect(screen.getByText('Segment')).toBeInTheDocument());
			expect(screen.getAllByText('mobile').length).toBeGreaterThan(0);
			// Retention also renders the salt-window note, so match the claim, not the role alone.
			await waitFor(() =>
				expect(
					screen.getByText('This tab cannot apply the active segment.'),
				).toBeInTheDocument(),
			);
		}
	});

	it('forwards the segment to the Realtime breakdowns but not to the snapshot', async () => {
		window.history.replaceState(null, '', '/?device=mobile');
		renderApp();
		fireEvent.click(screen.getByRole('tab', { name: 'Realtime' }));
		await waitFor(() =>
			expect(
				requested.some((u) => u.startsWith('/api/stats?') && u.includes('device=mobile')),
			).toBe(true),
		);
		// The snapshot endpoint takes site_id only; sending a filter it ignores would be a lie in the
		// network tab as much as on screen.
		expect(requested.filter((u) => u.includes('/api/stats/realtime')).join()).not.toContain(
			'device=',
		);
	});

	it('clears when the site profile changes', async () => {
		const OTHER = '22222222-2222-4222-8222-222222222222';
		localStorage.setItem(
			'facet.profiles',
			JSON.stringify([
				{ id: 'p1', label: 'Prod', siteId: VALID_SITE, apiKey: 'clk_x' },
				{ id: 'p2', label: 'Staging', siteId: OTHER, apiKey: 'clk_y' },
			]),
		);
		window.history.replaceState(null, '', '/?path=%2Fpricing');
		renderApp();
		fireEvent.click(screen.getByRole('tab', { name: 'Retention' }));
		await waitFor(() => expect(screen.getByText('/pricing')).toBeInTheDocument());

		// The switcher is a radio menu of saved profiles; picking the other one must drop the chip.
		fireEvent.click(screen.getByRole('button', { name: /Prod/ }));
		fireEvent.click(await screen.findByRole('menuitemradio', { name: /Staging/ }));
		await waitFor(() => expect(screen.queryByText('/pricing')).not.toBeInTheDocument());
		expect(window.location.search).not.toContain('path=');
	});
});
