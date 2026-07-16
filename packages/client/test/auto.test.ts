// T016: the auto-init bundle reads data-* attributes, installs the umami shim, fires one initial
// pageview, and auto-tracks a subsequent history.pushState navigation.

import { afterEach, describe, expect, it, vi } from 'vitest';

function setup(): { beacons: () => number } {
	let count = 0;
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
	return { beacons: () => count };
}

describe('auto-init', () => {
	afterEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it('installs the umami shim and fires exactly one initial pageview', async () => {
		const { beacons } = setup();
		await import('../src/auto.js');
		expect(typeof window.umami?.track).toBe('function');
		expect(typeof window.countless?.track).toBe('function');
		expect(beacons()).toBe(1);
	});

	it('auto-tracks a history.pushState navigation exactly once', async () => {
		const { beacons } = setup();
		await import('../src/auto.js');
		expect(beacons()).toBe(1);
		history.pushState({}, '', '/pricing');
		expect(beacons()).toBe(2);
	});
});
