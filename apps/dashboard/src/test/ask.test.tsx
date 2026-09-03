// The Ask panel: renders the answer + breakdown, labels model-chosen intent separately from computed
// numbers, formats each metric in its own unit, flags the server's silent default-intent fallback,
// runs against a per-panel window override, and builds copyable answer text.

import type { NlQueryResult } from '@facet/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AskPanel,
	buildAnswerText,
	describeIntent,
	errorHint,
	formatMetricValue,
	formatWindow,
} from '../components/AskPanel.js';
import { clockLabel, setClockMode } from '../lib/datetime.js';

const { cancelMock, mutateMock, state } = vi.hoisted(() => ({
	cancelMock: vi.fn(),
	mutateMock: vi.fn(),
	state: {
		isPending: false as boolean,
		error: null as Error | null,
		data: undefined as unknown,
	},
}));

vi.mock('../hooks/query.js', async () => {
	const actual = await vi.importActual<typeof import('../hooks/query.js')>('../hooks/query.js');
	return {
		...actual,
		useNlQuery: () => ({
			mutate: mutateMock,
			cancel: cancelMock,
			isPending: state.isPending,
			error: state.error,
			data: state.data,
		}),
	};
});

vi.mock('uplot', () => ({ default: class {} }));
vi.mock('uplot/dist/uPlot.min.css', () => ({}));

const BREAKDOWN: NlQueryResult = {
	intent: { metric: 'pageviews', dimension: 'country' },
	answer: 'Top country by pageviews: US (4), DE (2)',
	result: {
		kind: 'breakdown',
		rows: [
			{ key: 'US', count: 4 },
			{ key: 'DE', count: 2 },
		],
	},
};

const DAY = 24 * 60 * 60 * 1000;

function withQuery(ui: ReactElement): ReactElement {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function renderPanel(): void {
	render(withQuery(<AskPanel apiKey="clk_test" siteId="site-1" range={{ start: 0, end: 1 }} />));
}

beforeEach(() => {
	localStorage.clear();
	state.isPending = false;
	state.error = null;
	state.data = BREAKDOWN;
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('AskPanel', () => {
	it('renders the answer and breakdown rows', () => {
		renderPanel();
		expect(screen.getByText('Top country by pageviews: US (4), DE (2)')).toBeInTheDocument();
		expect(screen.getByText('US')).toBeInTheDocument();
		expect(screen.getByText('DE')).toBeInTheDocument();
		expect(screen.getByText('4')).toBeInTheDocument();
	});

	it('separates the model-chosen intent from the computed numbers', () => {
		renderPanel();
		expect(screen.getByText('Model chose')).toBeInTheDocument();
		expect(screen.getByText('metric: pageviews')).toBeInTheDocument();
		expect(screen.getByText('by: country')).toBeInTheDocument();
		expect(screen.getByText('Computed from your data')).toBeInTheDocument();
	});

	it('renders a bounce rate as a percentage, not a raw fraction', () => {
		state.data = {
			intent: { metric: 'bounce_rate' },
			answer: 'bounce_rate: 42%',
			result: { kind: 'scalar', value: 0.42 },
		} satisfies NlQueryResult;
		renderPanel();
		expect(screen.getByText('42%')).toBeInTheDocument();
		expect(screen.getByText('bounce rate')).toBeInTheDocument();
	});

	it('flags a result the server marked as its default-intent fallback', () => {
		state.data = {
			intent: { metric: 'pageviews' },
			answer: 'pageviews: 12',
			result: { kind: 'scalar', value: 12 },
			fallback: true,
		} satisfies NlQueryResult;
		renderPanel();
		expect(
			screen.getByText(/resolved to the default query: total pageviews/i),
		).toBeInTheDocument();
	});

	it('does not flag a real pageviews resolution', () => {
		state.data = {
			intent: { metric: 'pageviews' },
			answer: 'pageviews: 12',
			result: { kind: 'scalar', value: 12 },
			fallback: false,
		} satisfies NlQueryResult;
		renderPanel();
		expect(
			screen.queryByText(/resolved to the default query: total pageviews/i),
		).not.toBeInTheDocument();
	});

	it('asks over a panel-scoped window without touching the dashboard range', () => {
		state.data = undefined;
		renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Last 24h' }));
		fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'top pages' } });
		fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
		const vars = mutateMock.mock.calls[0]?.[0] as {
			question: string;
			range: { start: number };
		};
		expect(vars.question).toBe('top pages');
		// The dashboard range prop is { start: 0 }; a 24h preset resolves to a recent window.
		expect(vars.range.start).toBeGreaterThan(0);
	});

	it('explains a failure in terms the reader can act on', () => {
		state.data = undefined;
		state.error = new Error('ai_unavailable');
		renderPanel();
		expect(screen.getByRole('alert')).toHaveTextContent(/wrangler\.jsonc/);
	});

	it('names both stages while a question is in flight', () => {
		state.data = undefined;
		state.isPending = true;
		renderPanel();
		expect(screen.getByText(/Translating the question/)).toBeInTheDocument();
		expect(screen.getByText(/Running that query over your aggregates/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(cancelMock).toHaveBeenCalledOnce();
	});
});

describe('Ask helpers', () => {
	it('formats each metric in its own unit', () => {
		expect(formatMetricValue('pageviews', 1234)).toBe('1,234');
		expect(formatMetricValue('bounce_rate', 0.425)).toBe('42.5%');
	});

	it('describes each intent shape', () => {
		expect(describeIntent({ metric: 'visitors' })).toBe('Total visitors');
		expect(describeIntent({ metric: 'pageviews', series: true, interval: 'hour' })).toBe(
			'pageviews over time, bucketed by hour',
		);
		expect(describeIntent({ metric: 'pageviews', dimension: 'path', limit: 5 })).toBe(
			'Top 5 pages by pageviews',
		);
	});

	// An answer window is labelled in the reader's chosen clock and always names it. UTC is pinned
	// here so the literal is independent of the machine running the suite; the local case below
	// asserts the property that actually matters, which is that the label is never unattributed.
	it('labels a window in UTC, with times only for short windows', () => {
		setClockMode('utc');
		try {
			expect(formatWindow({ start: 0, end: 7 * DAY })).toBe('Jan 1 – Jan 8 UTC');
			expect(formatWindow({ start: 0, end: DAY })).toMatch(/00:00/);
		} finally {
			setClockMode('local');
		}
	});

	it('labels a window in the reader’s own clock by default, still naming it', () => {
		const label = formatWindow({ start: 0, end: 7 * DAY });
		expect(label.endsWith(clockLabel())).toBe(true);
		// Not silently UTC-under-another-name: the boundary is formatted in the host's zone, so a
		// host west of Greenwich sees the preceding day. Derived, not hardcoded, so this holds anywhere.
		const expectedStart = new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
		}).format(0);
		expect(label.startsWith(expectedStart)).toBe(true);
	});

	it('copies the answer together with its provenance and rows', () => {
		setClockMode('utc');
		const text = (() => {
			try {
				return buildAnswerText('top countries', { start: 0, end: 7 * DAY }, BREAKDOWN);
			} finally {
				setClockMode('local');
			}
		})();
		expect(text).toContain('Question: top countries');
		expect(text).toContain('Window: Jan 1 – Jan 8 UTC');
		expect(text).toContain('Resolved query: Top 10 countries by pageviews');
		expect(text).toContain('Answer: Top country by pageviews: US (4), DE (2)');
		expect(text).toContain('country\tcount');
		expect(text).toContain('US\t4');
	});

	it('maps every server error code for this endpoint to a remedy', () => {
		for (const code of [
			'ai_unavailable',
			'bad_request',
			'bad_range',
			'site_mismatch',
			'request_cancelled',
			'request_timeout',
		]) {
			expect(errorHint(code)).not.toContain(code);
		}
		expect(errorHint('kaboom')).toContain('kaboom');
	});
});
