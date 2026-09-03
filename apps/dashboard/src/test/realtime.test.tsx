// realtime view renders the metric + last-updated, distinguishes "quiet" from "nothing arriving",
// surfaces a breakdown failure instead of rendering nothing, exposes a pause control, and pauses
// polling (query disabled, no refetch interval) when the page is hidden or the user pauses.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Realtime, hasVariance } from '../components/Realtime.js';
import { useRealtime, useRealtimeBreakdown, useVisible } from '../hooks/realtime.js';
import { formatElapsed } from '../lib/datetime.js';

function setVisibility(state: 'visible' | 'hidden'): void {
	Object.defineProperty(document, 'visibilityState', {
		value: state,
		configurable: true,
	});
	document.dispatchEvent(new Event('visibilitychange'));
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }): ReactElement => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const SNAPSHOT = { window_ms: 300000, visitors: 7, pageviews: 21, until: Date.now() };
const ZERO = { window_ms: 300000, visitors: 0, pageviews: 0, until: Date.now() };

function ok(body: unknown) {
	return { ok: true, json: async () => body };
}

/** Route the two endpoints this view touches; `stats` may be a body or a rejection. */
function mockApi(opts: { realtime: unknown; stats?: unknown; statsFails?: boolean }) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (String(url).startsWith('/api/stats/realtime?')) return ok(opts.realtime);
			if (opts.statsFails) {
				return { ok: false, json: async () => ({ error: 'range_too_large' }) };
			}
			return ok(
				opts.stats ?? {
					summary: { pageviews: 0, visitors: 0, events: 0 },
					top_paths: [],
					top_referrers: [],
					top_countries: [],
					top_devices: [],
				},
			);
		}),
	);
}

function renderView(): void {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<Realtime apiKey="clk_x" siteId="s1" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	setVisibility('visible');
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setVisibility('visible');
});

describe('hasVariance', () => {
	it('rejects series with no shape to draw', () => {
		expect(hasVariance([])).toBe(false);
		expect(hasVariance([4])).toBe(false);
		// Sparkline pins a constant series to the bottom of the box, which reads as zero.
		expect(hasVariance([4, 4, 4])).toBe(false);
		expect(hasVariance([0, 0])).toBe(false);
	});

	it('accepts a series that actually moves', () => {
		expect(hasVariance([4, 5])).toBe(true);
		expect(hasVariance([4, 4, 3])).toBe(true);
	});
});

describe('formatElapsed', () => {
	it('uses seconds below 90s and minutes above', () => {
		expect(formatElapsed(0)).toBe('0s');
		expect(formatElapsed(15_000)).toBe('15s');
		expect(formatElapsed(89_000)).toBe('89s');
		expect(formatElapsed(90_000)).toBe('2m');
		expect(formatElapsed(180_000)).toBe('3m');
	});

	it('never reports a negative age', () => {
		expect(formatElapsed(-5000)).toBe('0s');
	});
});

describe('useVisible', () => {
	it('tracks document visibility', () => {
		const { result } = renderHook(() => useVisible());
		expect(result.current).toBe(true);
	});
});

describe('useRealtime gating', () => {
	it('disables the query and interval while hidden, re-enables when visible', () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		setVisibility('hidden');
		const hidden = renderHook(() => useRealtime('clk_x', 's1'), {
			wrapper: wrapper(client),
		});
		expect(hidden.result.current.isFetching).toBe(false);
		expect(hidden.result.current.fetchStatus).toBe('idle');
		hidden.unmount();

		setVisibility('visible');
		const visibleHook = renderHook(() => useRealtime('clk_x', 's1'), {
			wrapper: wrapper(client),
		});
		expect(visibleHook.result.current.fetchStatus).not.toBe('idle');
	});

	it('stops polling when explicitly paused', () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { result } = renderHook(() => useRealtime('clk_x', 's1', true), {
			wrapper: wrapper(client),
		});
		expect(result.current.fetchStatus).toBe('idle');
	});
});

describe('useRealtimeBreakdown', () => {
	it('does not fire a request before the snapshot supplies a window', () => {
		mockApi({ realtime: SNAPSHOT });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		// start === end is the pre-snapshot placeholder; the server rejects it with bad_range.
		const { result } = renderHook(() => useRealtimeBreakdown('clk_x', 's1', 0, 0), {
			wrapper: wrapper(client),
		});
		expect(result.current.fetchStatus).toBe('idle');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('fires the narrow context endpoint once the window is real', async () => {
		mockApi({ realtime: SNAPSHOT });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { result } = renderHook(() => useRealtimeBreakdown('clk_x', 's1', 1_000, 301_000), {
			wrapper: wrapper(client),
		});
		expect(result.current.fetchStatus).not.toBe('idle');
		await vi.waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				expect.stringContaining('/api/stats/realtime-context?'),
				expect.any(Object),
			),
		);
	});
});

describe('Realtime view', () => {
	it('renders the active-visitor metric and last-updated', async () => {
		mockApi({ realtime: SNAPSHOT });
		renderView();
		expect(await screen.findByText('Active visitors, last 5 min')).toBeInTheDocument();
		expect(screen.getByText(/Updated/)).toBeInTheDocument();
	});

	it('toggles the pause control', async () => {
		mockApi({ realtime: SNAPSHOT });
		renderView();
		const pause = await screen.findByRole('button', { name: /pause/i });
		expect(pause).toHaveAttribute('aria-pressed', 'false');
		fireEvent.click(pause);
		const resume = await screen.findByRole('button', { name: /resume/i });
		expect(resume).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByText(/Paused ·/)).toBeInTheDocument();
	});

	it('surfaces a breakdown failure instead of rendering nothing', async () => {
		mockApi({ realtime: SNAPSHOT, statsFails: true });
		renderView();
		expect(await screen.findByText('Live breakdowns could not be loaded')).toBeInTheDocument();
		// The counters still rendered: the page is half-degraded, not broken.
		expect(screen.getByText('Active visitors, last 5 min')).toBeInTheDocument();
	});

	it('shows the empty state for a zero snapshot', async () => {
		mockApi({ realtime: ZERO });
		renderView();
		expect(await screen.findByText('No active visitors right now')).toBeInTheDocument();
	});

	it('says tracking is reporting when the site had traffic in the last 24h', async () => {
		mockApi({
			realtime: ZERO,
			stats: { summary: { pageviews: 1200, visitors: 300, events: 0 } },
		});
		renderView();
		expect(await screen.findByText(/1,200 pageviews in the last 24 hours/)).toBeInTheDocument();
	});

	it('points at the snippet when nothing arrived in the last 24h either', async () => {
		mockApi({
			realtime: ZERO,
			stats: { summary: { pageviews: 0, visitors: 0, events: 0 } },
		});
		renderView();
		expect(
			await screen.findByText(/check the\s+tracking snippet is installed/),
		).toBeInTheDocument();
	});
});
