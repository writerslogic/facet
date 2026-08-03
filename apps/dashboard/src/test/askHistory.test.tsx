// recent-questions history — asking adds (bounded, case/whitespace-deduped, newest-first), replay
// re-runs, a single entry can be removed, and clear empties it.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskPanel } from '../components/AskPanel.js';
import {
	ASK_HISTORY_CAP,
	formatAskAge,
	pushAskHistory,
	readAskHistory,
	removeAskHistory,
} from '../lib/askHistory.js';

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));
vi.mock('../hooks/query.js', async () => {
	const actual = await vi.importActual<typeof import('../hooks/query.js')>('../hooks/query.js');
	return {
		...actual,
		useNlQuery: () => ({
			mutate: mutateMock,
			isPending: false,
			error: null,
			data: undefined,
		}),
	};
});

vi.mock('uplot', () => ({ default: class {} }));
vi.mock('uplot/dist/uPlot.min.css', () => ({}));

function withQuery(ui: ReactElement): ReactElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('askHistory store', () => {
	it('is newest-first, deduped, and bounded to the cap', () => {
		let now = 0;
		for (let i = 0; i < ASK_HISTORY_CAP + 5; i++) {
			pushAskHistory(`q${i}`, now++);
		}
		const list = readAskHistory();
		expect(list.length).toBe(ASK_HISTORY_CAP);
		expect(list[0]?.question).toBe(`q${ASK_HISTORY_CAP + 4}`);

		pushAskHistory('q0', now++);
		const deduped = readAskHistory().filter((e) => e.question === 'q0');
		expect(deduped.length).toBe(1);
		expect(readAskHistory()[0]?.question).toBe('q0');
	});

	it('dedupes across case and whitespace, keeping the newest spelling', () => {
		pushAskHistory('Top pages', 1);
		pushAskHistory('top   pages', 2);
		const list = readAskHistory();
		expect(list.length).toBe(1);
		expect(list[0]?.question).toBe('top   pages');
	});

	it('drops malformed entries on read', () => {
		localStorage.setItem(
			'facet.askHistory',
			JSON.stringify([
				{ question: 'ok', at: 5 },
				{ question: '   ', at: 6 },
				{ question: 'nan', at: Number.NaN },
				{ nope: true },
			]),
		);
		expect(readAskHistory()).toEqual([{ question: 'ok', at: 5 }]);
	});

	it('removes a single entry by its dedupe key', () => {
		pushAskHistory('top pages', 1);
		pushAskHistory('top referrers', 2);
		expect(removeAskHistory('TOP PAGES').map((e) => e.question)).toEqual(['top referrers']);
	});

	it('labels an entry age coarsely', () => {
		const now = 10 * 24 * 60 * 60 * 1000;
		expect(formatAskAge(now, now)).toBe('just now');
		expect(formatAskAge(now - 5 * 60_000, now)).toBe('5m ago');
		expect(formatAskAge(now - 3 * 60 * 60_000, now)).toBe('3h ago');
		expect(formatAskAge(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
	});
});

describe('AskPanel history', () => {
	it('asking adds to history, replay re-runs, remove and clear empty it', () => {
		render(withQuery(<AskPanel apiKey="clk_x" siteId="s1" range={{ start: 0, end: 1 }} />));

		fireEvent.change(screen.getByLabelText('Question'), {
			target: { value: 'top pages' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
		expect(mutateMock.mock.calls[0]?.[0]).toMatchObject({ question: 'top pages' });

		const chip = screen.getByRole('button', { name: 'top pages' });
		expect(chip).toBeInTheDocument();

		mutateMock.mockClear();
		fireEvent.click(chip);
		expect(mutateMock.mock.calls[0]?.[0]).toMatchObject({ question: 'top pages' });

		fireEvent.click(screen.getByRole('button', { name: /Remove "top pages"/ }));
		expect(screen.queryByRole('button', { name: 'top pages' })).not.toBeInTheDocument();

		fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'top referrers' } });
		fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
		fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
		expect(screen.queryByRole('button', { name: 'top referrers' })).not.toBeInTheDocument();
	});
});
