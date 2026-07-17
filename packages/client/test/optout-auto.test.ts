// Opt-out gating of the auto bundle: when opted out (DNT, data-facet-optout, or the localStorage
// kill switch) the bundle sends no initial pageview, no SPA navigation events, no form_submit, and
// reads no UTM. The umami shim obeys the same state, and whenReady() still resolves.

import { afterEach, describe, expect, it, vi } from 'vitest';

const SITE = '11111111-1111-4111-8111-111111111111';

interface Env {
	beacons: () => number;
	submit: (target: unknown) => void;
	pushState: () => void;
	popstate: () => void;
}

type Handler = (event: { target: unknown }) => void;

function setup(opts: {
	attrs?: Record<string, string>;
	dnt?: boolean;
	optout?: string;
}): Env {
	let count = 0;
	const attrs: Record<string, string | null> = {
		'data-site-id': SITE,
		...(opts.attrs ?? {}),
	};
	const docHandlers: Record<string, Handler> = {};
	const winHandlers: Record<string, () => void> = {};
	vi.stubGlobal('location', {
		href: 'https://shop.example.com/?utm_source=nl',
		hostname: 'shop.example.com',
		pathname: '/',
		search: '?utm_source=nl',
	});
	vi.stubGlobal('document', {
		referrer: '',
		currentScript: {
			getAttribute: (k: string) => attrs[k] ?? null,
			src: 'https://analytics.example.com/script.js',
		},
		addEventListener: (type: string, handler: Handler) => {
			docHandlers[type] = handler;
		},
	});
	const store: Record<string, string> = {};
	if (opts.optout !== undefined) store['facet.optout'] = opts.optout;
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store[k] ?? null,
		setItem: (k: string, v: string) => {
			store[k] = v;
		},
	});
	let pushImpl = (..._args: unknown[]) => undefined;
	vi.stubGlobal('history', {
		get pushState() {
			return pushImpl;
		},
		set pushState(fn: (..._args: unknown[]) => undefined) {
			pushImpl = fn;
		},
		replaceState: () => undefined,
	});
	vi.stubGlobal('window', {
		addEventListener: (type: string, handler: () => void) => {
			winHandlers[type] = handler;
		},
	} as unknown as Window);
	vi.stubGlobal('navigator', {
		...(opts.dnt ? { doNotTrack: '1' } : {}),
		sendBeacon: () => {
			count += 1;
			return true;
		},
	});
	return {
		beacons: () => count,
		submit: (target) => docHandlers.submit?.({ target }),
		pushState: () => history.pushState({}, '', '/x'),
		popstate: () => winHandlers.popstate?.(),
	};
}

function form() {
	return {
		tagName: 'FORM',
		id: 'signup',
		getAttribute: () => null,
		hasAttribute: () => false,
	};
}

describe('opt-out gates the auto bundle', () => {
	afterEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it('sends nothing when opted out via DNT: no pageview, SPA, form, or UTM', async () => {
		const env = setup({ dnt: true });
		await import('../src/auto.js');
		expect(env.beacons()).toBe(0);
		env.pushState();
		env.popstate();
		env.submit(form());
		await new Promise((r) => setTimeout(r, 0));
		expect(env.beacons()).toBe(0);
		// The umami shim obeys the same opt-out state.
		expect(typeof window.umami?.track).toBe('function');
		window.umami?.track('signup');
		await new Promise((r) => setTimeout(r, 0));
		expect(env.beacons()).toBe(0);
	});

	it('sends nothing when opted out via data-facet-optout', async () => {
		const env = setup({ attrs: { 'data-facet-optout': '' } });
		await import('../src/auto.js');
		expect(env.beacons()).toBe(0);
	});

	it('sends nothing when opted out via the localStorage kill switch', async () => {
		const env = setup({ optout: '1' });
		await import('../src/auto.js');
		expect(env.beacons()).toBe(0);
	});

	it('a false-like data-facet-optout does NOT opt out', async () => {
		const env = setup({ attrs: { 'data-facet-optout': 'false' } });
		await import('../src/auto.js');
		expect(env.beacons()).toBe(1);
	});

	it('the localStorage opt-in overrides DNT in the auto bundle', async () => {
		const env = setup({ dnt: true, optout: '0' });
		await import('../src/auto.js');
		expect(env.beacons()).toBe(1);
	});

	it('whenReady() resolves even when opted out', async () => {
		setup({ dnt: true });
		await import('../src/auto.js');
		await expect(window.facet?.whenReady()).resolves.toBeUndefined();
	});
});
