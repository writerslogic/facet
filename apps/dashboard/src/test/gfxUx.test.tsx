// goals/funnels/experiments UX. Missing prerequisites link to Settings; the Experiments view
// exposes explicit experiment + goal selectors and refetches on change; a deleted selection degrades.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Experiments } from '../components/Experiments.js';

const experimentsMock = vi.fn();
const goalsMock = vi.fn();
const resultMock = vi.fn();
const freshnessMock = vi.fn();

vi.mock('../hooks/experiments.js', () => ({
	useExperiments: () => experimentsMock(),
	useExperimentResult: (...args: unknown[]) => resultMock(...args),
}));
vi.mock('../hooks/funnels.js', () => ({
	useGoals: () => goalsMock(),
}));
vi.mock('../hooks/stats.js', () => ({
	useFreshness: () => freshnessMock(),
}));

function withQuery(ui: ReactElement): ReactElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const EXPS = [
	{
		id: 'e1',
		site_id: 's',
		name: 'CTA color',
		flag_key: 'cta',
		variants: [
			{ key: 'control', weight: 1 },
			{ key: 'blue', weight: 1 },
		],
		active: true,
		created_at: 0,
	},
	{
		id: 'e2',
		site_id: 's',
		name: 'Hero copy',
		flag_key: 'hero',
		variants: [
			{ key: 'control', weight: 1 },
			{ key: 'bold', weight: 1 },
		],
		active: true,
		created_at: 0,
	},
];

const GOALS = [
	{
		id: 'g1',
		site_id: 's',
		name: 'Signups',
		type: 'event',
		match_value: 'signup',
		created_at: 0,
	},
	{
		id: 'g2',
		site_id: 's',
		name: 'Purchase',
		type: 'event',
		match_value: 'buy',
		created_at: 0,
	},
];

const RESULT = {
	data: {
		variants: [
			{
				key: 'control',
				exposures: 10,
				conversions: 1,
				rate: 0.1,
				p_value: null,
				significant: false,
			},
		],
	},
	isLoading: false,
};

beforeEach(() => {
	freshnessMock.mockReturnValue({ data: null });
	resultMock.mockReturnValue(RESULT);
});

afterEach(() => {
	vi.clearAllMocks();
});

function renderExperiments(onOpenSettings = () => {}) {
	return render(
		withQuery(
			<Experiments
				apiKey="clk_x"
				siteId="s"
				range={{ start: 0, end: 1 }}
				onOpenSettings={onOpenSettings}
			/>,
		),
	);
}

describe('Experiments UX', () => {
	it('no experiments -> CTA to Settings', () => {
		experimentsMock.mockReturnValue({
			data: { experiments: [] },
			isLoading: false,
		});
		goalsMock.mockReturnValue({ data: { goals: GOALS }, isLoading: false });
		const spy = vi.fn();
		renderExperiments(spy);
		const cta = screen.getByRole('button', {
			name: 'Create an experiment in Settings',
		});
		fireEvent.click(cta);
		expect(spy).toHaveBeenCalled();
	});

	it('no goals -> CTA to Settings', () => {
		experimentsMock.mockReturnValue({
			data: { experiments: EXPS },
			isLoading: false,
		});
		goalsMock.mockReturnValue({ data: { goals: [] }, isLoading: false });
		renderExperiments();
		expect(
			screen.getByRole('button', { name: 'Create a goal in Settings' }),
		).toBeInTheDocument();
	});

	it('multiple -> explicit selectors, and changing selection refetches', () => {
		experimentsMock.mockReturnValue({
			data: { experiments: EXPS },
			isLoading: false,
		});
		goalsMock.mockReturnValue({ data: { goals: GOALS }, isLoading: false });
		renderExperiments();

		const expSelect = screen.getByLabelText('Experiment') as HTMLSelectElement;
		const goalSelect = screen.getByLabelText('Conversion goal') as HTMLSelectElement;
		expect(expSelect.value).toBe('e1');
		expect(goalSelect.value).toBe('g1');

		fireEvent.change(expSelect, { target: { value: 'e2' } });
		fireEvent.change(goalSelect, { target: { value: 'g2' } });

		// The result hook was called with the new experiment id and new goal object.
		const lastCall = resultMock.mock.calls.at(-1);
		expect(lastCall?.[2]).toBe('e2');
		expect(lastCall?.[3]).toMatchObject({ id: 'g2' });
	});

	it('a deleted selected experiment degrades to the first without crashing', () => {
		experimentsMock.mockReturnValue({
			data: { experiments: EXPS },
			isLoading: false,
		});
		goalsMock.mockReturnValue({ data: { goals: GOALS }, isLoading: false });
		const { rerender } = renderExperiments();

		fireEvent.change(screen.getByLabelText('Experiment'), {
			target: { value: 'e2' },
		});

		// e2 is deleted from the catalog.
		experimentsMock.mockReturnValue({
			data: { experiments: [EXPS[0]] },
			isLoading: false,
		});
		rerender(
			withQuery(
				<Experiments
					apiKey="clk_x"
					siteId="s"
					range={{ start: 0, end: 1 }}
					onOpenSettings={() => {}}
				/>,
			),
		);
		const expSelect = screen.getByLabelText('Experiment') as HTMLSelectElement;
		expect(expSelect.value).toBe('e1');
	});
});
