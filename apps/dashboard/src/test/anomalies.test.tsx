// The Anomalies view renders the plain-language autopsy summary for a detected anomaly, and the
// empty state when nothing is flagged.

import type { Anomaly } from '@facet/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Anomalies } from '../components/Anomalies.js';
import { clockLabel, setClockMode } from '../lib/datetime.js';
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

const HOUR = 3_600_000;

/**
 * An anomaly in the hour that started `hoursAgo` hours ago, hour-aligned like the detector's buckets.
 * Aligning down means the hour *ended* between `hoursAgo - 1` and `hoursAgo` hours ago, so the
 * rendered relative age is deterministic at `hoursAgo - 1`.
 */
function recent(hoursAgo: number, z: number): Anomaly {
	const bucket = Math.floor((Date.now() - hoursAgo * HOUR) / HOUR) * HOUR;
	return {
		metric: 'pageviews',
		bucket,
		value: 1840,
		baseline_mean: 940,
		z,
		direction: 'spike',
		diagnosis: null,
		summary: `Pageviews spiked in the hour starting ${bucket}.`,
	};
}

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

	it('renders the empty state for no anomalies, and says detection actually ran', () => {
		useAnomaliesMock.mockReturnValue({ data: { anomalies: [] } });
		render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		expect(screen.getByText('No anomalies detected')).toBeInTheDocument();
		expect(
			screen.getByText(/Every complete hour in this range was scored/),
		).toBeInTheDocument();
		expect(screen.getByText('No anomalies flagged in this range')).toBeInTheDocument();
	});

	it('summarizes count, severity and recency above the list', () => {
		useAnomaliesMock.mockReturnValue({ data: { anomalies: [recent(4, 6.2)] } });
		render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		expect(
			screen.getByText('1 anomaly in this range · 1 critical · latest 3h ago'),
		).toBeInTheDocument();
	});

	it('states the hour the anomaly covers and translates the z-score', () => {
		useAnomaliesMock.mockReturnValue({ data: { anomalies: [recent(4, 3.4)] } });
		const { container } = render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		// The exact hour, machine-readable, plus its age (which the summary line also carries). The
		// visible label is in the reader's own clock and NAMES it — the defect this guards against is
		// an unattributed timestamp, not a particular timezone.
		const stamp = container.querySelector('time');
		expect(stamp).toHaveAttribute('datetime');
		expect(stamp?.textContent ?? '').toContain(clockLabel());
		expect(screen.getAllByText(/3h ago/).length).toBeGreaterThan(0);
		// The jargon is translated, and the raw statistic stays for anyone who does know it.
		expect(
			screen.getByText(/3\.4x the site's usual hour-to-hour swing.*z-score 3\.4/),
		).toBeInTheDocument();
	});

	it('re-renders the hour in UTC when the reader switches clocks', () => {
		useAnomaliesMock.mockReturnValue({ data: { anomalies: [recent(4, 3.4)] } });
		setClockMode('utc');
		try {
			const { container } = render(
				withQuery(
					<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />,
				),
			);
			const stamp = container.querySelector('time');
			expect(stamp?.textContent?.endsWith('UTC')).toBe(true);
			// Same instant, different presentation: the machine-readable attribute never moves.
			expect(stamp).toHaveAttribute('datetime');
		} finally {
			setClockMode('local');
		}
	});

	it('undoes a dismissal from the inline offer', () => {
		useAnomaliesMock.mockReturnValue({ data: { anomalies: [recent(4, 6.2), recent(8, 3.2)] } });
		render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		const [first] = screen.getAllByRole('button', { name: 'Dismiss anomaly' });
		fireEvent.click(first as HTMLElement);
		expect(screen.getAllByRole('button', { name: 'Dismiss anomaly' })).toHaveLength(1);

		fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
		expect(screen.getAllByRole('button', { name: 'Dismiss anomaly' })).toHaveLength(2);
		expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
	});

	it('lists dismissed anomalies behind a toggle and restores them individually', () => {
		useAnomaliesMock.mockReturnValue({ data: { anomalies: [recent(4, 6.2), recent(8, 3.2)] } });
		render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		const [first] = screen.getAllByRole('button', { name: 'Dismiss anomaly' });
		fireEvent.click(first as HTMLElement);

		fireEvent.click(screen.getByRole('button', { name: /Show dismissed \(1\)/ }));
		fireEvent.click(screen.getByRole('button', { name: /Restore/ }));
		expect(screen.getAllByRole('button', { name: 'Dismiss anomaly' })).toHaveLength(2);
		expect(screen.queryByRole('button', { name: /Show dismissed/ })).toBeNull();
	});

	it('offers to restore when every anomaly has been dismissed', () => {
		useAnomaliesMock.mockReturnValue({ data: { anomalies: [recent(4, 6.2)] } });
		render(
			withQuery(<Anomalies apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />),
		);
		fireEvent.click(screen.getByRole('button', { name: 'Dismiss anomaly' }));
		expect(screen.getByText('Anomaly dismissed')).toBeInTheDocument();
		expect(screen.getByText(/Detection still ran over this range/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Restore it/ }));
		expect(screen.getByRole('button', { name: 'Dismiss anomaly' })).toBeInTheDocument();
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
		expect(screen.queryByText('Provable')).toBeNull();
	});

	// The badge says "Provable", not "Verified": at this point nothing has been checked, and the word
	// "Verified" is reserved for a badge whose drawer actually ran the cryptography and it passed.
	it('toggling Provenance overlays a Provable badge that opens the checkpoint proof', async () => {
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
		await waitFor(() => expect(screen.getByText('Provable')).toBeInTheDocument());
		fireEvent.click(screen.getByText('Provable'));
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
		expect(screen.queryByText('Provable')).toBeNull();
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
