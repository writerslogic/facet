// variant(): deterministic local bucketing from a random id in localStorage (never sent as
// identity), weights respected across ids, and exactly one $exposure event per flag per page load.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SITE = '11111111-1111-4111-8111-111111111111';
const HOST = 'https://analytics.example.com';

const FLAGS = {
	experiments: [
		{
			flag_key: 'cta',
			variants: [
				{ key: 'control', weight: 1 },
				{ key: 'blue', weight: 1 },
			],
		},
	],
};

function stubEnv(store: Record<string, string>): void {
	vi.stubGlobal('location', {
		href: `${HOST}/`,
		hostname: 'shop.example.com',
		pathname: '/',
		search: '',
	});
	vi.stubGlobal('document', { referrer: '' });
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store[k] ?? null,
		setItem: (k: string, v: string) => {
			store[k] = v;
		},
	});
}

describe('variant', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it('buckets deterministically for a fixed local id and fires one $exposure', async () => {
		const store: Record<string, string> = {
			'countless.exp': 'deadbeefdeadbeef',
		};
		stubEnv(store);
		const sent: Array<Record<string, unknown>> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) => {
				if (String(url).includes('/api/experiments/active')) {
					return Promise.resolve(new Response(JSON.stringify(FLAGS)));
				}
				return Promise.resolve(new Response(null, { status: 202 }));
			}),
		);
		vi.stubGlobal('navigator', {
			sendBeacon: (_u: string, blob: Blob) => {
				void blob.text().then((t) => sent.push(JSON.parse(t)));
				return true;
			},
		});

		const { init, variant } = await import('../src/index.js');
		init({ host: HOST, siteId: SITE });

		// First call before fetch resolves → control.
		expect(variant('cta')).toBe('control');
		// Let the flag fetch resolve.
		await new Promise((r) => setTimeout(r, 0));

		const first = variant('cta');
		const second = variant('cta');
		expect(first).toBe(second);
		expect(['control', 'blue']).toContain(first);

		await new Promise((r) => setTimeout(r, 0));
		const exposures = sent.filter((e) => e.name === '$exposure');
		expect(exposures).toHaveLength(1);
		expect((exposures[0]?.props as Record<string, unknown>)?.flag).toBe('cta');
		expect((exposures[0]?.props as Record<string, unknown>)?.variant).toBe(first);
	});

	it('respects weights roughly across many local ids', async () => {
		stubEnv({});
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) => {
				if (String(url).includes('/api/experiments/active')) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								experiments: [
									{
										flag_key: 'cta',
										variants: [
											{ key: 'control', weight: 3 },
											{ key: 'blue', weight: 1 },
										],
									},
								],
							}),
						),
					);
				}
				return Promise.resolve(new Response(null, { status: 202 }));
			}),
		);
		vi.stubGlobal('navigator', { sendBeacon: () => true });

		const mod = await import('../src/index.js');
		mod.init({ host: HOST, siteId: SITE });
		mod.variant('cta');
		await new Promise((r) => setTimeout(r, 0));

		// Bucket 400 distinct ids directly through the exported hash-based pick by swapping the
		// stored id each call; control (weight 3/4) should dominate.
		let control = 0;
		for (let i = 0; i < 400; i++) {
			localStorage.setItem('countless.exp', `id-${i}-${i * 7}`);
			if (mod.variant('cta') === 'control') control++;
		}
		expect(control).toBeGreaterThan(240); // ~75% expected, allow slack
		expect(control).toBeLessThan(360);
	});
});
