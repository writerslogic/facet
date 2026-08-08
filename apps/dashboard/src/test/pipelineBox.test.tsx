// The Overview pipeline box is the one tile on this board that reads session-cookie auth instead of
// the API-key stats path (see PipelineBox.tsx's header comment on the auth seam). The two things worth
// pinning: the four CRM access states render as a calm explanatory line rather than an alert, and the
// collapsed view picks one currency as the headline rather than summing unlike units.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pipelineBox } from '../components/boxes/PipelineBox.js';
import { DashboardProvider } from '../state.js';

function withDashboard(ui: ReactNode): ReactElement {
	localStorage.setItem(
		'facet.profiles',
		JSON.stringify([{ id: 'a', label: 'A', siteId: 'site-1', apiKey: 'clk_test' }]),
	);
	sessionStorage.setItem('facet.activeProfile', 'a');
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={client}>
			<DashboardProvider>{ui}</DashboardProvider>
		</QueryClientProvider>
	);
}

function mockPipeline(response: { status: number; body: unknown }): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok: response.status < 400,
			status: response.status,
			json: async () => response.body,
		})),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
	sessionStorage.clear();
});

describe('pipeline box', () => {
	it('explains a 501 as the deployment default, not an error', async () => {
		mockPipeline({ status: 501, body: { error: 'crm_unavailable' } });
		render(withDashboard(pipelineBox.render({} as never, false)));

		expect(
			await screen.findByText(/CRM extension is not enabled on this deployment/i),
		).toBeInTheDocument();
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('tells a signed-out viewer to sign in rather than showing a generic error', async () => {
		mockPipeline({ status: 401, body: { error: 'unauthenticated' } });
		render(withDashboard(pipelineBox.render({} as never, false)));

		expect(await screen.findByText(/Sign in with your operator account/i)).toBeInTheDocument();
	});

	it('picks the first currency as the collapsed headline and names the rest', async () => {
		mockPipeline({
			status: 200,
			body: {
				pipeline: [
					{
						currency: 'USD',
						open_value: 250000,
						open_count: 2,
						won_value: 120000,
						won_count: 1,
					},
					{
						currency: 'EUR',
						open_value: 50000,
						open_count: 1,
						won_value: 0,
						won_count: 0,
					},
				],
			},
		});
		render(withDashboard(pipelineBox.render({} as never, false)));

		expect(await screen.findByText('$2,500.00')).toBeInTheDocument();
		expect(screen.getByText(/USD/)).toBeInTheDocument();
		expect(screen.getByText(/\+1 more currency/)).toBeInTheDocument();
		// The second currency's figures are not summed in — only named as "more".
		expect(screen.queryByText('$500.00')).not.toBeInTheDocument();
	});

	it('lists every currency once expanded', async () => {
		mockPipeline({
			status: 200,
			body: {
				pipeline: [
					{
						currency: 'USD',
						open_value: 250000,
						open_count: 2,
						won_value: 120000,
						won_count: 1,
					},
					{
						currency: 'EUR',
						open_value: 50000,
						open_count: 1,
						won_value: 0,
						won_count: 0,
					},
				],
			},
		});
		render(withDashboard(pipelineBox.render({} as never, true)));

		expect(await screen.findByText('USD')).toBeInTheDocument();
		expect(screen.getByText('EUR')).toBeInTheDocument();
		expect(screen.getByText('$2,500.00')).toBeInTheDocument();
		expect(screen.getByText('€500.00')).toBeInTheDocument();
	});

	it('says there are no priced deals rather than showing a zero', async () => {
		mockPipeline({ status: 200, body: { pipeline: [] } });
		render(withDashboard(pipelineBox.render({} as never, false)));

		expect(await screen.findByText('No priced deals yet.')).toBeInTheDocument();
	});
});
