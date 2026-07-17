// realtime view renders the metric + last-updated, shows an empty state, and pauses polling
// (query disabled, no refetch interval) when the page is hidden.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Realtime } from '../components/Realtime.js';
import { useRealtime, useVisible } from '../hooks/realtime.js';

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

beforeEach(() => {
	setVisibility('visible');
});

afterEach(() => {
	vi.restoreAllMocks();
	setVisibility('visible');
});

describe('useVisible', () => {
	it('tracks document visibility', () => {
		const { result } = renderHook(() => useVisible());
		expect(result.current).toBe(true);
	});
});

describe('useRealtime visibility gating', () => {
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
});

describe('Realtime view', () => {
	it('renders the active-visitor metric and last-updated', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					window_ms: 300000,
					visitors: 7,
					pageviews: 21,
					until: Date.now(),
				}),
			}),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<Realtime apiKey="clk_x" siteId="s1" />
			</QueryClientProvider>,
		);
		expect(await screen.findByText('Active visitors, last 5 min')).toBeInTheDocument();
		expect(screen.getByText(/Last updated/)).toBeInTheDocument();
	});

	it('shows the empty state for a zero snapshot', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					window_ms: 300000,
					visitors: 0,
					pageviews: 0,
					until: Date.now(),
				}),
			}),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<Realtime apiKey="clk_x" siteId="s1" />
			</QueryClientProvider>,
		);
		expect(await screen.findByText('No active visitors right now')).toBeInTheDocument();
	});
});
