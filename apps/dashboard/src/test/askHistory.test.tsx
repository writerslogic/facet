// recent-questions history — asking adds (bounded, deduped, newest-first), replay re-runs, and
// clear empties it.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskPanel } from '../components/AskPanel.js';
import { ASK_HISTORY_CAP, pushAskHistory, readAskHistory } from '../lib/askHistory.js';

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));
vi.mock('../hooks/query.js', () => ({
	useNlQuery: () => ({
		mutate: mutateMock,
		isPending: false,
		error: null,
		data: undefined,
	}),
}));

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
});

describe('AskPanel history', () => {
	it('asking adds to history, replay re-runs, clear empties it', () => {
		render(withQuery(<AskPanel apiKey="clk_x" siteId="s1" range={{ start: 0, end: 1 }} />));

		fireEvent.change(screen.getByLabelText('Question'), {
			target: { value: 'top pages' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
		expect(mutateMock).toHaveBeenCalledWith('top pages');

		const chip = screen.getByRole('button', { name: 'top pages' });
		expect(chip).toBeInTheDocument();

		mutateMock.mockClear();
		fireEvent.click(chip);
		expect(mutateMock).toHaveBeenCalledWith('top pages');

		fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
		expect(screen.queryByRole('button', { name: 'top pages' })).not.toBeInTheDocument();
	});
});
