// The Anomalies view renders the plain-language autopsy summary for a detected anomaly, and the
// empty state when nothing is flagged.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Anomalies } from '../components/Anomalies.js';
import { DashboardProvider } from '../state.js';

const { useAnomaliesMock } = vi.hoisted(() => ({ useAnomaliesMock: vi.fn() }));

vi.mock('../hooks/anomaly.js', () => ({
	useAnomalies: useAnomaliesMock,
}));

function withQuery(ui: ReactElement): ReactElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/** Wrap with the providers VerifiedMetric/ProofDrawer need, seeding a profile so useDashboard has a key. */
function withDashboard(ui: ReactElement): ReactElement {
	localStorage.setItem(
		'facet.profiles',
		JSON.stringify([{ id: 'a', label: 'A', siteId: 'site-1', apiKey: 'clk_test' }]),
	);
	localStorage.setItem('facet.activeProfile', 'a');
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<DashboardProvider>{ui}</DashboardProvider>
		</QueryClientProvider>
	);
}

const ONE_ANOMALY = {
	anomalies: [
		{
			metric: 'pageviews',
			bucket: 0,
			value: 1,
			baseline_mean: 10,
			z: -3.5,
			direction: 'drop',
			diagnosis: null,
			summary: 'Pageviews dropped 90% in the last hour (z=-3.5).',
		},
	],
};

const CHECKPOINT = {
	statement: 'stmt',
	payload: {
		profile: 'p',
		size: 3,
		root: 'deadbeef',
		timestamp: '2026-01-01T00:00:00Z',
	},
	proof: {
		type: 'DataIntegrityProof',
		alg: 'EdDSA',
		kid: 'did:web:example#k1',
		publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'xx', alg: 'EdDSA' },
		created: '2026-01-01T00:00:00Z',
		jws: 'eyJ..sig',
	},
};

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe('Anomalies', () => {
	it('renders the autopsy summary for a detected anomaly', () => {
		useAnomaliesMock.mockReturnValue({
			data: {
				anomalies: [
					{
						metric: 'pageviews',
						bucket: 0,
						value: 1,
						baseline_mean: 10,
						z: -3.5,
						direction: 'drop',
						diagnosis: {
							dimension: 'device',
							value: 'mobile',
							current: 0,
							baseline_avg: 8,
						},
						summary:
							'Pageviews dropped 90% in the last hour (z=-3.5). Largest contributor: device=mobile (0 vs ~8 typical).',
					},
				],
			},
		});
		render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		expect(screen.getByText(/Pageviews dropped 90%/)).toBeInTheDocument();
	});

	it('renders the empty state for no anomalies', () => {
		useAnomaliesMock.mockReturnValue({ data: { anomalies: [] } });
		render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		expect(screen.getByText('No anomalies detected')).toBeInTheDocument();
	});

	it('provenance is off by default — no badge or attestation note', () => {
		useAnomaliesMock.mockReturnValue({ data: ONE_ANOMALY });
		render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		expect(screen.getByRole('switch', { name: /Provenance/i })).toHaveAttribute(
			'aria-checked',
			'false',
		);
		expect(screen.queryByText('Verified')).toBeNull();
	});

	it('toggling Provenance overlays a Verified badge that opens the checkpoint proof', async () => {
		useAnomaliesMock.mockReturnValue({ data: ONE_ANOMALY });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : String(input);
				if (url.includes('/api/transparency/checkpoint')) {
					return {
						ok: true,
						status: 200,
						json: async () => CHECKPOINT,
					};
				}
				return {
					ok: false,
					status: 404,
					json: async () => ({ error: 'not_found' }),
				};
			}),
		);
		render(
			withDashboard(
				<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />,
			),
		);
		fireEvent.click(screen.getByRole('switch', { name: /Provenance/i }));
		await waitFor(() => expect(screen.getByText('Verified')).toBeInTheDocument());
		fireEvent.click(screen.getByText('Verified'));
		await waitFor(() => expect(screen.getByText('deadbeef')).toBeInTheDocument());
	});

	it('explains when the deployment publishes no transparency log', async () => {
		useAnomaliesMock.mockReturnValue({ data: ONE_ANOMALY });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: false,
				status: 404,
				json: async () => ({ error: 'no_checkpoint' }),
			})),
		);
		render(
			withDashboard(
				<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />,
			),
		);
		fireEvent.click(screen.getByRole('switch', { name: /Provenance/i }));
		await waitFor(() =>
			expect(screen.getByText(/doesn't publish a transparency log/i)).toBeInTheDocument(),
		);
		expect(screen.queryByText('Verified')).toBeNull();
	});

	it('shows a checking state while the log lookup is in flight (not the false no-log claim)', async () => {
		useAnomaliesMock.mockReturnValue({ data: ONE_ANOMALY });
		// A checkpoint request that never resolves keeps the query in its loading state.
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise(() => {})),
		);
		render(
			withDashboard(
				<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />,
			),
		);
		fireEvent.click(screen.getByRole('switch', { name: /Provenance/i }));
		await waitFor(() =>
			expect(screen.getByText(/Checking for a transparency log/i)).toBeInTheDocument(),
		);
		// The in-flight frame must NOT assert the deployment has no log.
		expect(screen.queryByText(/doesn't publish a transparency log/i)).toBeNull();
	});
});
