// Assembled-board regression coverage for the fit/edit contract, disclosure, focus restoration,
// semantic tile names, and the prioritized phone feed. Geometry hooks are driven with a synchronous
// ResizeObserver so these are interaction tests, not jsdom guesses about an unmeasured viewport.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BentoBoard, BentoSkeleton } from '../components/BentoBoard.js';
import type { Slot, TileContext } from '../lib/tiles.js';

vi.mock('../components/LivePill.js', () => ({ LivePill: () => null }));

const SITE = 'board-test';
const LAYOUT_KEY = `facet.board.${SITE}`;

const stats = {
	summary: { pageviews: 70, visitors: 20, events: 8 },
	series: [],
	top_paths: [],
	top_referrers: [],
	top_events: [],
	top_countries: [],
	top_devices: [],
	engagement: { sessions: 20, bounce_rate: 0.4, pages_per_session: 2, avg_duration_ms: 1000 },
	channels: [],
	revenue: { total: 50, orders: 1, aov: 50, currency: 'USD' },
	revenue_by_channel: [{ key: 'email', count: 50 }],
	attribution: {
		conversions: 1,
		revenue: 50,
		models: {
			first: [{ key: 'email', count: 50 }],
			last: [{ key: 'email', count: 50 }],
			linear: [{ key: 'email', count: 50 }],
			position: [{ key: 'email', count: 50 }],
			time_decay: [{ key: 'email', count: 50 }],
			markov: [{ key: 'email', count: 50 }],
		},
	},
};

const ctx: TileContext = {
	summary: stats.summary,
	series: [],
	annotations: [],
	annotationManager: {
		notes: [],
		range: { start: 1, end: 2 },
		canManage: false,
		readOnlyReason: 'missing-admin',
		isLoading: false,
		isSaving: false,
		isDeleting: false,
		loadError: null,
		mutationError: null,
		create: async () => {},
		remove: async () => {},
		requestAdmin: () => {},
	},
	deltas: { pv: 5, vis: 4, ev: 3 },
	sparks: { pv: [1, 2], vis: [1, 2], ev: [1, 2] },
	sense: () => 'improvement',
	flowCells: [],
	data: stats,
	engagement: stats.engagement,
	anyFilter: false,
	cubeFilter: {},
	serverFilter: {},
	toggleServer: () => () => {},
	dimRows: () => [],
	dimSelect: () => undefined,
};

function repeatedPageviews(count: number): Slot[] {
	return Array.from({ length: count }, (_, index) => ({
		uid: `pageviews-${index}`,
		tileId: 'pageviews',
		size: 'kpi',
	}));
}

function board(editing = false): ReactElement {
	return <BentoBoard ctx={ctx} siteId={SITE} editing={editing} onEditingChange={() => {}} />;
}

let width = 1120;
let height = 100;
let widthSpy: ReturnType<typeof vi.spyOn>;
let heightSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	width = 1120;
	height = 100;
	widthSpy = vi
		.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
		.mockImplementation(() => width);
	heightSpy = vi
		.spyOn(HTMLElement.prototype, 'clientHeight', 'get')
		.mockImplementation(() => height);
	vi.stubGlobal(
		'ResizeObserver',
		class {
			private readonly callback: ResizeObserverCallback;

			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
			}

			observe(target: Element): void {
				this.callback(
					[
						{
							target,
							contentRect: target.getBoundingClientRect(),
						} as ResizeObserverEntry,
					],
					this as unknown as ResizeObserver,
				);
			}

			unobserve(): void {}
			disconnect(): void {}
		},
	);
});

afterEach(() => {
	widthSpy.mockRestore();
	heightSpy.mockRestore();
});

describe('BentoBoard visibility and editing', () => {
	it('offers an active disclosure for fit-hidden tiles and then renders all of them', async () => {
		localStorage.setItem(LAYOUT_KEY, JSON.stringify(repeatedPageviews(8)));
		render(board());

		const disclose = await screen.findByRole('button', { name: 'Show 4 more' });
		expect(screen.getAllByRole('region', { name: 'Pageviews' })).toHaveLength(4);

		fireEvent.click(disclose);
		expect(screen.getAllByRole('region', { name: 'Pageviews' })).toHaveLength(8);
		expect(screen.queryByRole('button', { name: 'Show 4 more' })).toBeNull();
	});

	it('renders and edits every tile even when the resting viewport is full', async () => {
		localStorage.setItem(LAYOUT_KEY, JSON.stringify(repeatedPageviews(7)));
		render(board(true));

		expect(await screen.findAllByRole('listitem')).toHaveLength(7);
		fireEvent.click(screen.getByRole('button', { name: 'Add tile' }));
		fireEvent.click(screen.getByRole('button', { name: 'Countries' }));

		expect(screen.getAllByRole('listitem')).toHaveLength(8);
		expect(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '[]')).toHaveLength(8);
	});

	it('gives the skeleton the same fit and scrolling visibility contract', async () => {
		localStorage.setItem(LAYOUT_KEY, JSON.stringify(repeatedPageviews(8)));
		const fit = render(<BentoSkeleton siteId={SITE} />);
		await waitFor(() =>
			expect(fit.container.querySelectorAll('.animate-pulse')).toHaveLength(4),
		);
		fit.unmount();

		localStorage.setItem(`facet.boardPrefs.${SITE}`, JSON.stringify({ scroll: true }));
		const scrolling = render(<BentoSkeleton siteId={SITE} />);
		await waitFor(() =>
			expect(scrolling.container.querySelectorAll('.animate-pulse')).toHaveLength(8),
		);
	});
});

describe('BentoBoard semantics and focus', () => {
	it('renders a persisted optional tile after its implementation chunk loads', async () => {
		localStorage.setItem(
			LAYOUT_KEY,
			JSON.stringify([{ uid: 'attribution', tileId: 'attribution', size: 'lg' }]),
		);
		height = 600;
		render(board());

		expect(await screen.findByRole('region', { name: 'Attribution' })).toBeInTheDocument();
		expect(await screen.findByText(/Last touch/)).toBeInTheDocument();
	});

	it('names a self-labelled tile and restores focus after closing detail', async () => {
		localStorage.setItem(LAYOUT_KEY, JSON.stringify(repeatedPageviews(1)));
		height = 600;
		render(board());

		expect(await screen.findByRole('region', { name: 'Pageviews' })).toBeInTheDocument();
		const actions = screen.getByRole('button', { name: 'Pageviews actions' });
		fireEvent.click(actions);
		fireEvent.click(screen.getByRole('menuitem', { name: 'Expand detail' }));

		const close = await screen.findByRole('button', { name: 'Close Pageviews detail' });
		expect(close).toHaveFocus();
		fireEvent.click(close);

		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Pageviews actions' })).toHaveFocus(),
		);
	});
});

describe('BentoBoard phone layout', () => {
	it('prioritizes a KPI strip followed by vertically stacked insights', async () => {
		width = 390;
		height = 700;
		localStorage.setItem(
			LAYOUT_KEY,
			JSON.stringify([
				{ uid: 'traffic', tileId: 'traffic', size: 'xl' },
				...repeatedPageviews(3),
			]),
		);
		render(board());

		const feed = await screen.findByLabelText('Overview feed');
		const metrics = within(feed).getByRole('region', { name: 'Key metrics' });
		expect(within(metrics).getAllByRole('region', { name: 'Pageviews' })).toHaveLength(3);
		expect(within(feed).getByRole('region', { name: 'Traffic over time' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Previous box|Next box/ })).toBeNull();
	});
});
