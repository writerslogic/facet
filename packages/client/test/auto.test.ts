// The auto-init bundle reads data-* attributes, installs the umami shim, fires one initial
// pageview, and auto-tracks a subsequent history.pushState navigation. It also collapses the
// same-path pageview a SPA router fires when it normalizes the URL on mount.

import { afterEach, describe, expect, it, vi } from 'vitest';

function setup(): { beacons: () => number; goto: (path: string) => void } {
	let count = 0;
	const loc = {
		href: 'https://shop.example.com/',
		hostname: 'shop.example.com',
		pathname: '/',
		search: '',
	};
	vi.stubGlobal('location', loc);
	vi.stubGlobal('document', {
		referrer: '',
		addEventListener: () => {},
		currentScript: {
			getAttribute: (k: string) =>
				k === 'data-site-id' ? '11111111-1111-4111-8111-111111111111' : null,
			src: 'https://analytics.example.com/script.js',
		},
	});
	vi.stubGlobal('history', {
		pushState: (..._args: unknown[]) => undefined,
		replaceState: (..._args: unknown[]) => undefined,
	});
	vi.stubGlobal('window', { addEventListener: vi.fn() } as unknown as Window);
	vi.stubGlobal('navigator', {
		sendBeacon: () => {
			count += 1;
			return true;
		},
	});
	// A real pushState moves location; the stub must too, or every navigation looks like a repeat.
	return {
		beacons: () => count,
		goto: (path: string) => {
			loc.pathname = path;
			history.pushState({}, '', path);
		},
	};
}

describe('auto-init', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it('installs the umami shim and fires exactly one initial pageview', async () => {
		const { beacons } = setup();
		await import('../src/auto.js');
		expect(typeof window.umami?.track).toBe('function');
		expect(typeof window.facet?.track).toBe('function');
		expect(beacons()).toBe(1);
	});

	it('auto-tracks a history.pushState navigation exactly once', async () => {
		const { beacons, goto } = setup();
		await import('../src/auto.js');
		expect(beacons()).toBe(1);
		goto('/pricing');
		expect(beacons()).toBe(2);
	});

	it('collapses the same-path replaceState a SPA router fires on mount', async () => {
		const { beacons } = setup();
		await import('../src/auto.js');
		// react-router normalizes the URL immediately after mount: same path, no new pageview.
		history.replaceState({}, '', '/');
		expect(beacons()).toBe(1);
	});

	it('counts a return to a path already visited earlier in the session', async () => {
		const { beacons, goto } = setup();
		await import('../src/auto.js');
		goto('/pricing');
		goto('/');
		expect(beacons()).toBe(3);
	});

	it('counts a repeat of the same path once the collapse window has passed', async () => {
		vi.useFakeTimers();
		const { beacons } = setup();
		await import('../src/auto.js');
		expect(beacons()).toBe(1);
		vi.advanceTimersByTime(1000);
		history.pushState({}, '', '/');
		expect(beacons()).toBe(2);
	});
});
