import type { TimelineAnnotation } from '@facet/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type TimelineAnnotationManager, TimelineNotes } from '../components/TimelineNotes.js';
import { setClockMode } from '../lib/datetime.js';

const START = Date.parse('2026-08-01T00:00:00.000Z');
const END = Date.parse('2026-08-08T00:00:00.000Z');

const NOTE: TimelineAnnotation = {
	id: 'note-1',
	site_id: '11111111-1111-4111-8111-111111111111',
	label: 'Checkout release',
	category: 'release',
	occurred_at: START + 86_400_000,
	created_at: START + 86_400_001,
};

function manager(overrides: Partial<TimelineAnnotationManager> = {}): TimelineAnnotationManager {
	return {
		notes: [],
		range: { start: START, end: END },
		canManage: true,
		readOnlyReason: null,
		isLoading: false,
		isSaving: false,
		isDeleting: false,
		loadError: null,
		mutationError: null,
		create: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn().mockResolvedValue(undefined),
		requestAdmin: vi.fn(),
		...overrides,
	};
}

afterEach(() => {
	setClockMode('local');
	vi.restoreAllMocks();
});

describe('TimelineNotes', () => {
	it('creates typed context at the entered UTC instant and clears the label', async () => {
		setClockMode('utc');
		const state = manager();
		render(<TimelineNotes manager={state} />);
		fireEvent.click(screen.getByRole('button', { name: 'Manage' }));

		fireEvent.change(screen.getByLabelText('What changed'), {
			target: { value: 'Newsletter launched' },
		});
		fireEvent.change(screen.getByLabelText('When (UTC)'), {
			target: { value: '2026-08-04T15:30' },
		});
		fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'campaign' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

		await waitFor(() =>
			expect(state.create).toHaveBeenCalledWith({
				label: 'Newsletter launched',
				category: 'campaign',
				occurred_at: Date.parse('2026-08-04T15:30:00.000Z'),
			}),
		);
		expect(screen.getByLabelText('What changed')).toHaveValue('');
	});

	it('shows saved context and requires confirmation before removal', async () => {
		setClockMode('utc');
		const state = manager({ notes: [NOTE] });
		render(<TimelineNotes manager={state} />);
		expect(screen.getByText('Checkout release')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
		expect(screen.getAllByText('Release').length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(state.remove).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		await waitFor(() => expect(state.remove).toHaveBeenCalledWith('note-1'));
	});

	it('keeps notes readable but sends non-admin operators to settings for mutations', () => {
		const state = manager({
			notes: [NOTE],
			canManage: false,
			readOnlyReason: 'missing-admin',
		});
		render(<TimelineNotes manager={state} />);
		expect(screen.getByText('Checkout release')).toBeInTheDocument();
		expect(screen.queryByLabelText('What changed')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'View' }));
		fireEvent.click(screen.getByRole('button', { name: 'Open admin settings' }));
		expect(state.requestAdmin).toHaveBeenCalledOnce();
	});

	it('names the public demo as read-only without presenting a broken admin-token CTA', () => {
		const state = manager({ notes: [NOTE], canManage: false, readOnlyReason: 'demo' });
		render(<TimelineNotes manager={state} />);
		fireEvent.click(screen.getByRole('button', { name: 'View' }));
		expect(screen.getByText(/public demo is read-only/)).toBeInTheDocument();
		expect(
			screen.queryByRole('button', { name: 'Open admin settings' }),
		).not.toBeInTheDocument();
	});
});
