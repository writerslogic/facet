// Visitor opt-out & Do-Not-Track: a single source of truth consulted by every collection path.
// Covers DNT signals, the data-facet-optout script attribute semantics, the localStorage kill
// switch and its precedence over DNT, the optOut()/optIn()/isOptedOut() API, and safe degradation
// when localStorage throws.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SITE = '11111111-1111-4111-8111-111111111111';
const HOST = 'https://analytics.example.com';

function stubPage(): void {
	vi.stubGlobal('location', {
		href: `${HOST}/`,
		hostname: 'shop.example.com',
		pathname: '/',
		search: '',
	});
	vi.stubGlobal('document', { referrer: '' });
}

/** In-memory localStorage stub. */
function stubStorage(store: Record<string, string> = {}): Record<string, string> {
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store[k] ?? null,
		setItem: (k: string, v: string) => {
			store[k] = v;
		},
	});
	return store;
}

describe('opt-out state', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('is opted in by default (no DNT, no attr, no storage)', async () => {
		stubPage();
		stubStorage();
		vi.stubGlobal('navigator', {});
		const { isOptedOut } = await import('../src/optout.js');
		expect(isOptedOut()).toBe(false);
	});

	it('honors navigator.doNotTrack === "1"', async () => {
		stubPage();
		stubStorage();
		vi.stubGlobal('navigator', { doNotTrack: '1' });
		const { isOptedOut } = await import('../src/optout.js');
		expect(isOptedOut()).toBe(true);
	});

	it('honors navigator.doNotTrack === "yes" and msDoNotTrack === "1"', async () => {
		stubPage();
		stubStorage();
		vi.stubGlobal('navigator', { doNotTrack: 'yes' });
		const { isOptedOut } = await import('../src/optout.js');
		expect(isOptedOut()).toBe(true);
		vi.stubGlobal('navigator', { msDoNotTrack: '1' });
		expect(isOptedOut()).toBe(true);
	});

	it('honors window.doNotTrack === "1"', async () => {
		stubPage();
		stubStorage();
		vi.stubGlobal('navigator', {});
		vi.stubGlobal('window', { doNotTrack: '1' } as unknown as Window);
		const { isOptedOut } = await import('../src/optout.js');
		expect(isOptedOut()).toBe(true);
	});

	it('opts out for a bare / true / "1" data-facet-optout attribute', async () => {
		stubPage();
		stubStorage();
		vi.stubGlobal('navigator', {});
		const { isOptedOut, setOptOutScript } = await import('../src/optout.js');
		for (const value of ['', 'true', '1', 'yes-please']) {
			setOptOutScript({
				getAttribute: (k) => (k === 'data-facet-optout' ? value : null),
			});
			expect(isOptedOut()).toBe(true);
		}
	});

	it('does NOT opt out for false-like data-facet-optout values', async () => {
		stubPage();
		stubStorage();
		vi.stubGlobal('navigator', {});
		const { isOptedOut, setOptOutScript } = await import('../src/optout.js');
		for (const value of ['false', '0', 'no', 'off', 'FALSE', 'Off']) {
			setOptOutScript({
				getAttribute: (k) => (k === 'data-facet-optout' ? value : null),
			});
			expect(isOptedOut()).toBe(false);
		}
	});

	it('localStorage kill switch opts out ("1"/"true")', async () => {
		stubPage();
		stubStorage({ 'facet.optout': '1' });
		vi.stubGlobal('navigator', {});
		const { isOptedOut } = await import('../src/optout.js');
		expect(isOptedOut()).toBe(true);
	});

	it('localStorage explicit opt-in OVERRIDES DNT', async () => {
		stubPage();
		stubStorage({ 'facet.optout': '0' });
		vi.stubGlobal('navigator', { doNotTrack: '1' });
		const { isOptedOut } = await import('../src/optout.js');
		expect(isOptedOut()).toBe(false);
	});

	it('localStorage explicit opt-in OVERRIDES a data-facet-optout attribute', async () => {
		stubPage();
		stubStorage({ 'facet.optout': 'false' });
		vi.stubGlobal('navigator', {});
		const { isOptedOut, setOptOutScript } = await import('../src/optout.js');
		setOptOutScript({ getAttribute: () => 'true' });
		expect(isOptedOut()).toBe(false);
	});

	it('optOut()/optIn() take effect immediately and isOptedOut() re-reads state', async () => {
		stubPage();
		stubStorage();
		vi.stubGlobal('navigator', {});
		const { isOptedOut, optIn, optOut } = await import('../src/optout.js');
		expect(isOptedOut()).toBe(false);
		optOut();
		expect(isOptedOut()).toBe(true);
		optIn();
		expect(isOptedOut()).toBe(false);
	});

	it('degrades safely when localStorage throws (private mode)', async () => {
		stubPage();
		vi.stubGlobal('navigator', {});
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
		});
		const { isOptedOut, optIn, optOut } = await import('../src/optout.js');
		// No throw, defaults to opted in.
		expect(isOptedOut()).toBe(false);
		// optOut() persists to the in-memory fallback and is honored immediately.
		optOut();
		expect(isOptedOut()).toBe(true);
		optIn();
		expect(isOptedOut()).toBe(false);
	});
});

describe('opt-out blocks collection', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('track() no-ops when opted out via DNT', async () => {
		stubPage();
		stubStorage();
		const beacon = vi.fn(() => true);
		vi.stubGlobal('navigator', { doNotTrack: '1', sendBeacon: beacon });
		const { init, track } = await import('../src/index.js');
		init({ host: HOST, siteId: SITE });
		track('signup');
		await new Promise((r) => setTimeout(r, 0));
		expect(beacon).not.toHaveBeenCalled();
	});

	it('track() resumes after optIn() overrides DNT', async () => {
		stubPage();
		stubStorage();
		const beacon = vi.fn(() => true);
		vi.stubGlobal('navigator', { doNotTrack: '1', sendBeacon: beacon });
		const { init, track } = await import('../src/index.js');
		const { optIn } = await import('../src/optout.js');
		init({ host: HOST, siteId: SITE });
		optIn();
		track('signup');
		await new Promise((r) => setTimeout(r, 0));
		expect(beacon).toHaveBeenCalledOnce();
	});
});
