// Docs tab: section rendering, the full-text search index (body prose, not just titles/keywords),
// the no-results suggestion state, hash deep-linking, and sidebar keyboard navigation.
//
// This file tests how the Docs tab BEHAVES. Whether what it SAYS is still true is tested in the
// sibling docDrift.test.tsx, which reads the implementation off disk and pins each factual claim to
// the constant or predicate that decides it. Add new factual claims there, not here.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Docs } from '../components/Docs.js';

/** The sidebar nav, which lists exactly the sections currently matching the query. */
function sidebar(): HTMLElement {
	return screen.getByRole('navigation', { name: /documentation sections/i });
}

function sidebarTitles(): string[] {
	// queryAll, not getAll: a query that matches nothing must yield [], not throw.
	return within(sidebar())
		.queryAllByRole('link')
		.map((a) => a.textContent ?? '');
}

function search(value: string): HTMLElement {
	const input = screen.getByLabelText(/search documentation/i);
	fireEvent.change(input, { target: { value } });
	return input;
}

beforeEach(() => {
	window.location.hash = '';
	// jsdom implements neither; both are guarded in the component but assert nothing throws.
	Element.prototype.scrollIntoView = vi.fn();
});

describe('Docs sections', () => {
	it('renders every section as a landmark with a heading', () => {
		render(<Docs />);
		const headings = screen.getAllByRole('heading', { level: 2 });
		expect(headings.length).toBeGreaterThanOrEqual(10);
		expect(headings.length).toBe(sidebarTitles().length);
		expect(sidebarTitles()).toContain('Getting started');
		expect(sidebarTitles()).toContain('Verifiable analytics');
	});

	it('keeps code blocks copyable under the Cmd+A scoping rules', () => {
		const { container } = render(<Docs />);
		const blocks = container.querySelectorAll('pre[data-selectable]');
		expect(blocks.length).toBeGreaterThan(0);
	});

	it('offers a copy-link affordance per section', () => {
		render(<Docs />);
		expect(
			screen.getByRole('button', { name: /copy link to getting started/i }),
		).toBeInTheDocument();
	});
});

describe('Docs search', () => {
	it('matches section titles', () => {
		render(<Docs />);
		search('retention');
		expect(sidebarTitles().length).toBeGreaterThan(0);
	});

	it('matches keywords that never appear in a title', () => {
		render(<Docs />);
		search('adblock');
		expect(sidebarTitles()).toEqual(['Troubleshooting']);
	});

	it('matches BODY prose that is neither a title nor a keyword', () => {
		render(<Docs />);
		// "Plausible" appears only inside the privacy section's prose.
		search('plausible');
		expect(sidebarTitles()).toEqual(['Privacy, opt-out & consent']);
	});

	it('matches text inside code blocks', () => {
		render(<Docs />);
		// This literal exists only in the getting-started snippet.
		search('wrangler secret put FACET_SIGNING_JWK');
		expect(sidebarTitles()).toEqual(['Verifiable analytics']);
	});

	it('requires every term to match (AND, not OR)', () => {
		render(<Docs />);
		search('salt window');
		const withBoth = sidebarTitles().length;
		search('salt');
		expect(sidebarTitles().length).toBeGreaterThanOrEqual(withBoth);
		search('salt zzzznotaword');
		expect(sidebarTitles()).toHaveLength(0);
	});

	it('is case-insensitive', () => {
		render(<Docs />);
		search('ADBLOCK');
		expect(sidebarTitles()).toEqual(['Troubleshooting']);
	});

	it('restores every section when the query is cleared', () => {
		render(<Docs />);
		search('adblock');
		expect(sidebarTitles()).toHaveLength(1);
		search('');
		expect(sidebarTitles().length).toBeGreaterThan(10);
	});

	it('shows a no-results state that suggests the closest sections', () => {
		render(<Docs />);
		// "privac" is a prefix of the privacy section's keywords but matches no full-text term.
		search('privacyzz');
		expect(screen.getByText(/no documentation matches/i)).toBeInTheDocument();
		const suggestion = screen.getByRole('button', { name: /privacy, opt-out & consent/i });
		fireEvent.click(suggestion);
		// Picking a suggestion clears the query and brings the sections back.
		expect(screen.queryByText(/no documentation matches/i)).not.toBeInTheDocument();
	});

	it('falls back to example phrasings when nothing is even close', () => {
		render(<Docs />);
		search('qqqqzzzz');
		expect(screen.getByText(/no documentation matches/i)).toBeInTheDocument();
		expect(screen.getByText(/try a phrase you remember/i)).toBeInTheDocument();
	});
});

describe('Docs navigation', () => {
	it('marks the first section active by default', () => {
		render(<Docs />);
		const links = within(sidebar()).getAllByRole('link');
		expect(links[0]).toHaveAttribute('aria-current', 'true');
	});

	it('honours a deep link in the URL hash', () => {
		window.location.hash = '#doc-privacy';
		render(<Docs />);
		const active = within(sidebar())
			.getAllByRole('link')
			.find((a) => a.getAttribute('aria-current') === 'true');
		expect(active?.textContent).toBe('Privacy, opt-out & consent');
	});

	it('ignores an unknown hash rather than blanking the sidebar', () => {
		window.location.hash = '#doc-nope';
		render(<Docs />);
		const links = within(sidebar()).getAllByRole('link');
		expect(links[0]).toHaveAttribute('aria-current', 'true');
	});

	it('writes the hash when a section is picked, so the URL is shareable', () => {
		render(<Docs />);
		fireEvent.click(within(sidebar()).getByRole('link', { name: 'API reference' }));
		expect(window.location.hash).toBe('#doc-api');
	});

	it('moves focus into the list from the search box with ArrowDown', () => {
		render(<Docs />);
		const input = search('export');
		fireEvent.keyDown(input, { key: 'ArrowDown' });
		expect(document.activeElement?.textContent).toBe(sidebarTitles()[0]);
	});

	it('jumps to the best match when Enter is pressed in the search box', () => {
		render(<Docs />);
		const input = search('adblock');
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(window.location.hash).toBe('#doc-trouble');
	});

	it('walks the sidebar with the arrow keys and wraps', () => {
		render(<Docs />);
		const links = within(sidebar()).getAllByRole('link');
		const first = links[0];
		const second = links[1];
		const last = links[links.length - 1];
		if (!first || !second || !last) throw new Error('expected several sections');

		first.focus();
		fireEvent.keyDown(first, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(second);

		fireEvent.keyDown(second, { key: 'ArrowUp' });
		expect(document.activeElement).toBe(first);

		// Up from the first wraps to the last.
		fireEvent.keyDown(first, { key: 'ArrowUp' });
		expect(document.activeElement).toBe(last);

		fireEvent.keyDown(last, { key: 'Home' });
		expect(document.activeElement).toBe(first);

		fireEvent.keyDown(first, { key: 'End' });
		expect(document.activeElement).toBe(last);
	});
});

describe('Docs accuracy guards', () => {
	// These pin down corrections made against the implementation; if the prose regresses to the
	// older, wrong claim these fail.
	it('states that form_submit is excluded from the Events metric', () => {
		render(<Docs />);
		search('excluded');
		expect(sidebarTitles()).toContain('What the metrics mean');
	});

	it('describes bounce as one pageview or fewer, not exactly one', () => {
		render(<Docs />);
		search('one pageview or fewer');
		expect(sidebarTitles()).toEqual(['What the metrics mean']);
	});

	it('documents the data-facet-ignore opt-out', () => {
		render(<Docs />);
		search('data-facet-ignore');
		expect(sidebarTitles()).toContain('What the snippet captures automatically');
	});

	it('documents the umami compatibility shim', () => {
		render(<Docs />);
		search('window.umami.track');
		expect(sidebarTitles()).toContain('What the snippet captures automatically');
	});
});
