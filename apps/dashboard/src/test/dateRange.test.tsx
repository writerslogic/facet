// an invalid custom range shows an inline error and does not apply; a valid one applies
// and updates the store; the compare toggle flips state.

import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DateRange } from '../components/DateRange.js';
import { DashboardProvider, useDashboard } from '../state.js';

function Probe(): ReactElement {
	const { selection, compare } = useDashboard();
	return (
		<div>
			<span data-testid="kind">{selection.kind}</span>
			<span data-testid="compare">{String(compare)}</span>
		</div>
	);
}

function renderControl() {
	return render(
		<DashboardProvider>
			<DateRange />
			<Probe />
		</DashboardProvider>,
	);
}

beforeEach(() => {
	localStorage.clear();
	window.history.replaceState(null, '', '/');
});

afterEach(() => {
	window.history.replaceState(null, '', '/');
});

describe('DateRange custom + compare', () => {
	it('rejects an invalid custom range with an inline error and does not apply', () => {
		renderControl();
		fireEvent.click(screen.getByRole('button', { name: /Custom/ }));
		fireEvent.change(screen.getByLabelText('Start'), {
			target: { value: '2024-02-10' },
		});
		fireEvent.change(screen.getByLabelText('End'), {
			target: { value: '2024-02-01' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

		expect(screen.getByRole('alert')).toHaveTextContent(/before/);
		expect(screen.getByTestId('kind')).toHaveTextContent('preset');
	});

	it('applies a valid custom range', () => {
		renderControl();
		fireEvent.click(screen.getByRole('button', { name: /Custom/ }));
		fireEvent.change(screen.getByLabelText('Start'), {
			target: { value: '2024-02-01' },
		});
		fireEvent.change(screen.getByLabelText('End'), {
			target: { value: '2024-02-10' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

		expect(screen.getByTestId('kind')).toHaveTextContent('custom');
	});

	it('toggles compare', () => {
		renderControl();
		expect(screen.getByTestId('compare')).toHaveTextContent('false');
		fireEvent.click(screen.getByRole('checkbox', { name: /Compare/ }));
		expect(screen.getByTestId('compare')).toHaveTextContent('true');
	});
});
