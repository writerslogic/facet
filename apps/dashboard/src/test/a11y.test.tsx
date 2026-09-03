// Regression cover for the whole-surface accessibility audit. Every case here pins a defect that was
// found by driving the real app (axe-core + a keyboard-only pass) and is reproducible in jsdom: ARIA
// wiring, roles, labels, heading levels, landmarks and focus management. The findings that are NOT
// here — colour contrast, whether a focus outline actually paints, whether an element is covered by
// another element's stacking context — need layout and computed style, so they are verified in a real
// browser instead (see the audit report), not asserted against jsdom's empty CSSOM.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { AdminProvider } from '../admin.js';
import { DateRange } from '../components/DateRange.js';
import { ExportButton } from '../components/ExportButton.js';
import { Layout } from '../components/Layout.js';
import { ProofDrawer } from '../components/ProofDrawer.js';
import { SiteSwitcher } from '../components/SiteSwitcher.js';
import { DashboardProvider } from '../state.js';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

function okStats() {
	return {
		summary: { pageviews: 0, visitors: 0, events: 0 },
		series: [],
		top_paths: [],
		top_referrers: [],
		top_events: [],
		top_countries: [],
		top_devices: [],
		engagement: { sessions: 0, bounce_rate: 0, pages_per_session: 0, avg_duration_ms: 0 },
		channels: [],
	};
}

function seedProfiles(): void {
	localStorage.setItem(
		'facet.profiles',
		JSON.stringify([
			{ id: 'p-a', label: 'Marketing site', siteId: SITE_A, apiKey: 'clk_a' },
			{ id: 'p-b', label: 'Docs site', siteId: SITE_B, apiKey: 'clk_b' },
		]),
	);
	sessionStorage.setItem('facet.activeProfile', 'p-a');
}

function wrap(node: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<DashboardProvider>
				<AdminProvider>{node}</AdminProvider>
			</DashboardProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState(null, '', '/');
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => okStats() }));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('document structure', () => {
	it('gives every view exactly one h1, naming the view', async () => {
		seedProfiles();
		wrap(<App />);
		await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(10));

		const h1s = () => document.querySelectorAll('h1');
		expect(h1s()).toHaveLength(1);
		expect(h1s()[0]?.textContent).toBe('Overview');

		fireEvent.click(screen.getByRole('tab', { name: 'Retention' }));
		await waitFor(() => expect(h1s()[0]?.textContent).toBe('Retention'));
		expect(h1s()).toHaveLength(1);
	});

	it('keeps the h1 out of a Cmd+A copy of the data (it is chrome, not a metric)', async () => {
		seedProfiles();
		wrap(<App />);
		await waitFor(() => expect(document.querySelector('h1')).not.toBeNull());
		expect(document.querySelector('h1')).toHaveAttribute('data-chrome');
	});

	it('puts the attribution inside a landmark rather than loose in the body', () => {
		wrap(
			<Layout onToggleSettings={() => {}} settingsActive={false}>
				<p>content</p>
			</Layout>,
		);
		const footer = screen.getByRole('contentinfo');
		expect(within(footer).getByRole('link', { name: /Powered by Facet/ })).toBeInTheDocument();
	});

	it('offers a skip link that targets the main landmark', () => {
		wrap(
			<Layout onToggleSettings={() => {}} settingsActive={false}>
				<p>content</p>
			</Layout>,
		);
		expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
			'href',
			'#facet-main',
		);
		expect(screen.getByRole('main')).toHaveAttribute('id', 'facet-main');
	});
});

describe('view tablist', () => {
	it('wires each tab to the panel it selects', async () => {
		seedProfiles();
		wrap(<App />);
		await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(10));

		const selected = screen.getByRole('tab', { selected: true });
		const panel = screen.getByRole('tabpanel');
		expect(selected).toHaveAttribute('aria-controls', panel.id);
		expect(panel).toHaveAttribute('aria-labelledby', selected.id);
	});

	it('is a single tab stop with roving tabindex', async () => {
		seedProfiles();
		wrap(<App />);
		await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(10));

		const tabs = screen.getAllByRole('tab');
		expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);
		expect(tabs.filter((t) => t.tabIndex === -1)).toHaveLength(9);
	});

	it('moves selection with Left/Right/Home/End, as role=tablist promises', async () => {
		seedProfiles();
		wrap(<App />);
		await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(10));

		fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), { key: 'ArrowRight' });
		await waitFor(() =>
			expect(screen.getByRole('tab', { name: 'Explore' })).toHaveAttribute(
				'aria-selected',
				'true',
			),
		);

		fireEvent.keyDown(screen.getByRole('tab', { name: 'Explore' }), { key: 'End' });
		await waitFor(() =>
			expect(screen.getByRole('tab', { name: 'Documentation' })).toHaveAttribute(
				'aria-selected',
				'true',
			),
		);

		fireEvent.keyDown(screen.getByRole('tab', { name: 'Documentation' }), { key: 'Home' });
		await waitFor(() =>
			expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
				'aria-selected',
				'true',
			),
		);
	});
});

describe('site switcher menu', () => {
	it('owns only menuitem-family children, so the menu role is valid', () => {
		seedProfiles();
		wrap(<SiteSwitcher />);
		fireEvent.click(screen.getByRole('button', { name: /Change site/ }));

		const menu = screen.getByRole('menu', { name: 'Sites' });
		for (const child of Array.from(menu.children)) {
			const role = child.getAttribute('role');
			const ok =
				role === 'presentation' ||
				role === 'none' ||
				role === 'menuitem' ||
				role === 'menuitemradio' ||
				child.tagName === 'HR';
			expect(ok, `unexpected menu child <${child.tagName} role=${role}>`).toBe(true);
		}
	});

	it('reaches the per-site Edit control with the arrow keys', () => {
		seedProfiles();
		wrap(<SiteSwitcher />);
		fireEvent.click(screen.getByRole('button', { name: /Change site/ }));

		// Edit is a menuitem now — it used to be a plain button that arrows skipped and Tab
		// dismissed the menu before reaching, making it unreachable without a mouse.
		const edit = screen.getByRole('menuitem', { name: 'Edit Marketing site' });
		expect(edit).toBeInTheDocument();

		const active = screen.getByRole('menuitemradio', { name: /Marketing site/ });
		fireEvent.keyDown(active, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(edit);
	});

	it('leaves one tab stop in the menu (roving tabindex)', () => {
		seedProfiles();
		wrap(<SiteSwitcher />);
		fireEvent.click(screen.getByRole('button', { name: /Change site/ }));

		const items = screen.getByRole('menu').querySelectorAll('button');
		expect(Array.from(items).filter((b) => b.tabIndex === 0)).toHaveLength(1);
	});

	it('clears a leftover search filter on dismiss, so the next open shows every site', () => {
		// Past SEARCH_THRESHOLD (8) the menu grows a filter box.
		localStorage.setItem(
			'facet.profiles',
			JSON.stringify(
				Array.from({ length: 9 }, (_, i) => ({
					id: `p-${i}`,
					label: `Site ${i}`,
					siteId: `${i}1111111-1111-4111-8111-111111111111`,
					apiKey: `clk_${i}`,
				})),
			),
		);
		sessionStorage.setItem('facet.activeProfile', 'p-0');
		wrap(<SiteSwitcher />);

		fireEvent.click(screen.getByRole('button', { name: /Change site/ }));
		fireEvent.change(screen.getByPlaceholderText('Filter sites…'), {
			target: { value: 'Site 3' },
		});
		expect(screen.getAllByRole('menuitemradio')).toHaveLength(1);

		// Dismiss via outside click rather than Escape/selecting a row — the path the fix covers.
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole('menu')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Change site/ }));
		expect(screen.getAllByRole('menuitemradio')).toHaveLength(9);
	});
});

describe('site profile dialog', () => {
	function openAddDialog(): void {
		seedProfiles();
		wrap(<SiteSwitcher />);
		fireEvent.click(screen.getByRole('button', { name: /Change site/ }));
		fireEvent.click(screen.getByRole('menuitem', { name: 'Add a site' }));
	}

	it('is named by its visible heading', () => {
		openAddDialog();
		const dialog = screen.getByRole('dialog');
		expect(dialog).toHaveAccessibleName('Add a site');
	});

	it('moves focus into the dialog on open', () => {
		openAddDialog();
		expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
	});

	it('closes on Escape, which the aria-modal promise requires', async () => {
		openAddDialog();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('keeps Tab inside the dialog', () => {
		openAddDialog();
		const dialog = screen.getByRole('dialog');
		const focusable = dialog.querySelectorAll<HTMLElement>(
			'a[href],button:not([disabled]),input:not([disabled]),select,textarea',
		);
		const last = focusable[focusable.length - 1];
		last?.focus();
		fireEvent.keyDown(window, { key: 'Tab' });
		expect(dialog.contains(document.activeElement)).toBe(true);
	});
});

describe('proof drawer', () => {
	const checkpoint = {
		payload: { root: 'abc', size: 4, timestamp: '2026-01-01T00:00:00Z' },
		proof: { alg: 'ES256', kid: 'k1', publicJwk: { kty: 'EC' }, jws: 'sig' },
	};

	it('closes on Escape and restores focus to whatever opened it', async () => {
		seedProfiles();
		const trigger = document.createElement('button');
		trigger.textContent = 'Verified';
		document.body.appendChild(trigger);
		trigger.focus();

		const onClose = vi.fn();
		wrap(<ProofDrawer checkpoint={checkpoint as any} onClose={onClose} />);
		expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

		fireEvent.keyDown(window, { key: 'Escape' });
		expect(onClose).toHaveBeenCalled();
		trigger.remove();
	});
});

describe('header popovers', () => {
	it('closes the export menu on Escape and returns focus to the trigger', async () => {
		render(
			<ExportButton
				apiKey="clk_a"
				siteId={SITE_A}
				range={{ start: 1, end: 2 }}
				interval="day"
			/>,
		);
		const trigger = screen.getByRole('button', { name: /Export CSV/ });
		fireEvent.click(trigger);
		expect(screen.getByRole('menu', { name: 'Export CSV' })).toBeInTheDocument();

		fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(document.activeElement).toBe(trigger);
	});

	it('gives each export breakdown a name that stands on its own', () => {
		render(
			<ExportButton
				apiKey="clk_a"
				siteId={SITE_A}
				range={{ start: 1, end: 2 }}
				interval="day"
			/>,
		);
		fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
		expect(
			screen.getByRole('menuitem', { name: 'Breakdown by Top pages' }),
		).toBeInTheDocument();
		expect(screen.getByRole('menuitem', { name: 'Time series' })).toBeInTheDocument();
	});

	it('closes the custom-range popover on Escape and returns focus to the trigger', async () => {
		seedProfiles();
		wrap(<DateRange />);
		const trigger = screen.getByRole('button', { name: /Custom/ });
		fireEvent.click(trigger);
		expect(screen.getByRole('group', { name: 'Custom range (UTC)' })).toBeInTheDocument();

		fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.queryByRole('group', { name: 'Custom range (UTC)' })).toBeNull(),
		);
		expect(document.activeElement).toBe(trigger);
	});

	it('names the preset row so its four toggles are not four loose controls', () => {
		seedProfiles();
		wrap(<DateRange />);
		expect(screen.getByRole('group', { name: 'Date range preset' })).toBeInTheDocument();
	});
});
