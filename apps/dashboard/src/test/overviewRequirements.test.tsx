import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOverviewData } from '../features/overview/hooks.js';
import {
	activeImplementationGroups,
	comparisonRequirements,
	requirementsForLayout,
	statementCount,
} from '../features/overview/requirements.js';
import { DEFAULT_LAYOUT, type Slot } from '../lib/tiles.js';

const SITE = '00000000-0000-4000-8000-000000000001';
const QUERY = { site_id: SITE, start: 1, end: 2, interval: 'hour' as const };

function response(url: string): unknown {
	if (url.startsWith('/api/stats/core?')) {
		return { summary: { pageviews: 1, visitors: 1, events: 1 }, series: [] };
	}
	if (url.startsWith('/api/stats/summary?')) {
		return { summary: { pageviews: 1, visitors: 1, events: 1 } };
	}
	if (url.startsWith('/api/stats/cube?')) return { interval: 'hour', cells: [] };
	if (url.startsWith('/api/stats/content?')) return { top_paths: [], top_events: [] };
	if (url.startsWith('/api/stats/attribution?')) {
		return {
			revenue: { total: 0, orders: 0, aov: 0, currency: null },
			revenue_by_channel: [],
			attribution: {
				conversions: 0,
				revenue: 0,
				models: {
					first: [],
					last: [],
					linear: [],
					position: [],
					time_decay: [],
					markov: [],
				},
			},
		};
	}
	throw new Error(`unexpected request: ${url}`);
}

function wrapper(client: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
	return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('Overview layout requirements', () => {
	it('keeps the default layout on core, cube, and content contracts only', () => {
		const requirements = requirementsForLayout(DEFAULT_LAYOUT);
		expect([...requirements]).toEqual(['core', 'content', 'cube']);
		expect([...activeImplementationGroups(DEFAULT_LAYOUT)]).toEqual(['core']);
		expect(statementCount(requirements)).toBe(6);
		expect(statementCount(comparisonRequirements(DEFAULT_LAYOUT))).toBe(5);
	});

	it('adds and removes only the attribution requirement and implementation group', () => {
		const optional: Slot = { uid: 'attr', tileId: 'attribution', size: 'lg' };
		const withAttribution = [...DEFAULT_LAYOUT, optional];
		expect([...requirementsForLayout(withAttribution)]).toEqual([
			'core',
			'content',
			'cube',
			'attribution',
		]);
		expect([...activeImplementationGroups(withAttribution)]).toEqual(['core', 'attribution']);
		expect(requirementsForLayout(DEFAULT_LAYOUT).has('attribution')).toBe(false);
	});

	it('plans comparison-only contracts per tile', () => {
		expect([...comparisonRequirements([{ tileId: 'flow' }])]).toEqual([]);
		expect([...comparisonRequirements([{ tileId: 'engagement' }])]).toEqual(['engagement']);
		expect([...comparisonRequirements([{ tileId: 'revenue' }])]).toEqual(['revenue']);
	});

	it('uses summary rather than core for a requirements-aware comparison window', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			return new Response(JSON.stringify(response(url)), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const requirements = comparisonRequirements(DEFAULT_LAYOUT);
		const { result } = renderHook(
			() => useOverviewData('clk_test', { ...QUERY, start: -1, end: 1 }, requirements),
			{ wrapper: wrapper(client) },
		);
		await waitFor(() => expect(result.current.data).toBeDefined());
		const urls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(urls.some((url) => url.startsWith('/api/stats/summary?'))).toBe(true);
		expect(urls.some((url) => url.startsWith('/api/stats/core?'))).toBe(false);
		expect(urls.some((url) => /^\/api\/stats\?/.test(url))).toBe(false);
	});

	it('fetches no full or optional analytics for the default and stops attribution after removal', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			return new Response(JSON.stringify(response(url)), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
		});
		const defaultRequirements = requirementsForLayout(DEFAULT_LAYOUT);
		const attributionRequirements = requirementsForLayout([
			...DEFAULT_LAYOUT,
			{ tileId: 'attribution' },
		]);
		const { result, rerender } = renderHook(
			({ requirements }) => useOverviewData('clk_test', QUERY, requirements),
			{
				initialProps: { requirements: defaultRequirements },
				wrapper: wrapper(client),
			},
		);
		await waitFor(() => expect(result.current.data).toBeDefined());
		const defaultUrls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(defaultUrls.some((url) => /^\/api\/stats\?/.test(url))).toBe(false);
		expect(defaultUrls.some((url) => url.startsWith('/api/stats/attribution?'))).toBe(false);
		expect(defaultUrls.some((url) => url.startsWith('/api/stats/technology?'))).toBe(false);

		rerender({ requirements: attributionRequirements });
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.filter(([url]) =>
					String(url).startsWith('/api/stats/attribution?'),
				),
			).toHaveLength(1),
		);
		expect(
			fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/stats/revenue?')),
		).toBe(false);

		rerender({ requirements: defaultRequirements });
		await client.invalidateQueries();
		expect(
			fetchMock.mock.calls.filter(([url]) =>
				String(url).startsWith('/api/stats/attribution?'),
			),
		).toHaveLength(1);
	});
});
