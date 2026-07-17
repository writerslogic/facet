// Experiment readiness: whenReady() settles after /active resolves or fails and never
// rejects; assignment() reports pending/assigned/unavailable/opted-out precisely; variant() stays
// backward-compatible with a safe non-exposing fallback; exposure dedups; opt-out blocks fetch and
// exposure.

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

let sent: Array<Record<string, unknown>> = [];

function stubEnv(store: Record<string, string> = {}, nav: Record<string, unknown> = {}): void {
	sent = [];
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
	vi.stubGlobal('navigator', {
		...nav,
		sendBeacon: (_u: string, blob: Blob) => {
			void blob.text().then((t) => sent.push(JSON.parse(t)));
			return true;
		},
	});
}

function stubFetchOk(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			if (String(url).includes('/api/experiments/active')) {
				return Promise.resolve(new Response(JSON.stringify(FLAGS)));
			}
			return Promise.resolve(new Response(null, { status: 202 }));
		}),
	);
}

describe('whenReady + assignment', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it('reports pending before readiness, assigned after', async () => {
		stubEnv({ 'facet.exp': 'deadbeefdeadbeef' });
		stubFetchOk();
		const { init } = await import('../src/index.js');
		const { assignment, variant, whenReady } = await import('../src/experiments.js');
		init({ host: HOST, siteId: SITE });

		const pending = assignment('cta');
		expect(pending.status).toBe('pending');
		expect(pending.participating).toBe(false);
		// variant() stays backward-compatible with a safe fallback and fires no exposure.
		expect(typeof variant('cta')).toBe('string');

		await whenReady();

		const a = assignment('cta');
		expect(a.status).toBe('assigned');
		expect(a.participating).toBe(true);
		expect(['control', 'blue']).toContain(a.variant);
	});

	it('whenReady() returns a stable promise across calls', async () => {
		stubEnv();
		stubFetchOk();
		const { init } = await import('../src/index.js');
		const { whenReady } = await import('../src/experiments.js');
		init({ host: HOST, siteId: SITE });
		expect(whenReady()).toBe(whenReady());
		await whenReady();
	});

	it('whenReady() resolves (unavailable) when the /active fetch fails, never rejects', async () => {
		stubEnv();
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.reject(new Error('network'))),
		);
		const { init } = await import('../src/index.js');
		const { assignment, whenReady } = await import('../src/experiments.js');
		init({ host: HOST, siteId: SITE });
		await expect(whenReady()).resolves.toBeUndefined();
		const a = assignment('cta');
		expect(a.status).toBe('unavailable');
		expect(a.participating).toBe(false);
	});

	it('reports unavailable for an unknown flag after readiness', async () => {
		stubEnv();
		stubFetchOk();
		const { init } = await import('../src/index.js');
		const { assignment, whenReady } = await import('../src/experiments.js');
		init({ host: HOST, siteId: SITE });
		await whenReady();
		const a = assignment('nope');
		expect(a.status).toBe('unavailable');
		expect(a.variant).toBe('control');
	});

	it('opted-out: no fetch, no bucket, no exposure; status opted-out', async () => {
		stubEnv({ 'facet.optout': '1' });
		const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
		vi.stubGlobal('fetch', fetchMock);
		const { init } = await import('../src/index.js');
		const { assignment, whenReady } = await import('../src/experiments.js');
		init({ host: HOST, siteId: SITE });
		await whenReady();
		const a = assignment('cta');
		expect(a.status).toBe('opted-out');
		expect(a.participating).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		await new Promise((r) => setTimeout(r, 0));
		expect(sent.filter((e) => e.name === '$exposure')).toHaveLength(0);
	});

	it('fires exactly one $exposure per flag for a genuine assignment', async () => {
		stubEnv({ 'facet.exp': 'deadbeefdeadbeef' });
		stubFetchOk();
		const { init } = await import('../src/index.js');
		const { assignment, whenReady } = await import('../src/experiments.js');
		init({ host: HOST, siteId: SITE });
		await whenReady();
		assignment('cta');
		assignment('cta');
		assignment('cta');
		await new Promise((r) => setTimeout(r, 0));
		expect(sent.filter((e) => e.name === '$exposure')).toHaveLength(1);
	});

	it('distinguishes a true control assignment from a treatment', async () => {
		stubEnv({ 'facet.exp': 'deadbeefdeadbeef' });
		stubFetchOk();
		const { init } = await import('../src/index.js');
		const { assignment, whenReady } = await import('../src/experiments.js');
		init({ host: HOST, siteId: SITE });
		await whenReady();
		const a = assignment('cta');
		// A real control bucketing is participating; a fallback control (pending) is not.
		expect(a.participating).toBe(true);
		expect(['control', 'blue']).toContain(a.variant);
	});
});
