// severity mapping from |z|, and the dismiss flow — dismissing one anomaly hides only that
// bucket while a different-bucket anomaly still shows.

import type { Anomaly } from '@facet/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Anomalies } from '../components/Anomalies.js';
import { severityFor } from '../lib/anomaly.js';

const { useAnomaliesMock } = vi.hoisted(() => ({ useAnomaliesMock: vi.fn() }));
vi.mock('../hooks/anomaly.js', () => ({ useAnomalies: useAnomaliesMock }));

function withQuery(ui: ReactElement): ReactElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function anomaly(bucket: number, z: number): Anomaly {
	return {
		metric: 'pageviews',
		bucket,
		value: 1,
		baseline_mean: 10,
		z,
		direction: 'drop',
		diagnosis: {
			dimension: 'device',
			value: 'mobile',
			current: 0,
			baseline_avg: 8,
		},
		summary: `Pageviews dropped in bucket ${bucket} (z=${z}).`,
	};
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('severityFor', () => {
	it('maps |z| to critical / high / moderate', () => {
		expect(severityFor(-7)).toBe('critical');
		expect(severityFor(6)).toBe('critical');
		expect(severityFor(-5)).toBe('high');
		expect(severityFor(4.5)).toBe('high');
		expect(severityFor(-3.5)).toBe('moderate');
		expect(severityFor(2)).toBe('moderate');
	});
});

describe('Anomalies severity + dismiss', () => {
	it('renders a labeled severity badge', () => {
		useAnomaliesMock.mockReturnValue({
			data: { anomalies: [anomaly(1000, -7)] },
		});
		render(withQuery(<Anomalies apiKey="clk_x" siteId="s1" range={{ start: 0, end: 1 }} />));
		expect(screen.getByText('Critical')).toBeInTheDocument();
	});

	it('dismisses one bucket while a different bucket still shows', () => {
		useAnomaliesMock.mockReturnValue({
			data: { anomalies: [anomaly(1000, -7), anomaly(2000, -5)] },
		});
		render(withQuery(<Anomalies apiKey="clk_x" siteId="s1" range={{ start: 0, end: 1 }} />));
		expect(screen.getByText(/bucket 1000/)).toBeInTheDocument();
		expect(screen.getByText(/bucket 2000/)).toBeInTheDocument();

		const [firstDismiss] = screen.getAllByRole('button', {
			name: 'Dismiss anomaly',
		});
		fireEvent.click(firstDismiss as HTMLElement);

		expect(screen.queryByText(/bucket 1000/)).not.toBeInTheDocument();
		expect(screen.getByText(/bucket 2000/)).toBeInTheDocument();
	});
});
