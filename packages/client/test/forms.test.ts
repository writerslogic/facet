// T056: the auto bundle fires a `form_submit` event (no field values) on a form submission, and
// respects the data-facet-ignore opt-out.

import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: { target: unknown }) => void;

function setup(): {
	submit: (target: unknown) => void;
	bodies: () => unknown[];
} {
	const handlers: Record<string, Handler> = {};
	const sent: string[] = [];
	vi.stubGlobal('location', {
		href: 'https://shop.example.com/',
		hostname: 'shop.example.com',
		pathname: '/',
		search: '',
	});
	vi.stubGlobal('document', {
		referrer: '',
		currentScript: {
			getAttribute: (k: string) =>
				k === 'data-site-id' ? '11111111-1111-4111-8111-111111111111' : null,
			src: 'https://analytics.example.com/script.js',
		},
		addEventListener: (type: string, handler: Handler) => {
			handlers[type] = handler;
		},
	});
	vi.stubGlobal('history', {
		pushState: () => undefined,
		replaceState: () => undefined,
	});
	vi.stubGlobal('window', { addEventListener: vi.fn() } as unknown as Window);
	vi.stubGlobal('navigator', {
		sendBeacon: (_url: string, blob: Blob) => {
			void blob.text().then((t) => sent.push(t));
			return true;
		},
	});
	return {
		submit: (target: unknown) => handlers.submit?.({ target }),
		bodies: () => sent.map((s) => JSON.parse(s)),
	};
}

function form(attrs: {
	id?: string;
	name?: string;
	action?: string;
	ignore?: boolean;
}) {
	return {
		tagName: 'FORM',
		id: attrs.id ?? '',
		getAttribute: (k: string) =>
			k === 'name' ? (attrs.name ?? null) : k === 'action' ? (attrs.action ?? null) : null,
		hasAttribute: (k: string) => k === 'data-facet-ignore' && Boolean(attrs.ignore),
	};
}

describe('form tracking', () => {
	afterEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it('fires a form_submit event with the form id', async () => {
		const h = setup();
		await import('../src/auto.js');
		h.submit(form({ id: 'signup', name: 'signup-form' }));
		await new Promise((r) => setTimeout(r, 0));
		const submits = h.bodies().filter((b) => (b as { name?: string }).name === 'form_submit');
		expect(submits).toHaveLength(1);
		expect((submits[0] as { props: { form_id: string } }).props.form_id).toBe('signup');
	});

	it('ignores forms marked data-facet-ignore', async () => {
		const h = setup();
		await import('../src/auto.js');
		h.submit(form({ id: 'private', ignore: true }));
		await new Promise((r) => setTimeout(r, 0));
		const submits = h.bodies().filter((b) => (b as { name?: string }).name === 'form_submit');
		expect(submits).toHaveLength(0);
	});
});
