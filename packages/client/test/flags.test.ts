// flags client: evaluates on the server (POST /api/flags/eval) and caches the assignment map for the
// page. Asserts it sends the stable local id + non-identifying ctx (never country/device), reads
// variants/participation back, defaults safely while pending, and never evaluates when opted out.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SITE = '11111111-1111-4111-8111-111111111111';
const HOST = 'https://analytics.example.com';

const EVAL_RESPONSE = {
	flags: {
		'new-checkout': {
			variant: 'treatment',
			participating: true,
			reason: 'rollout',
		},
		'dark-mode': { variant: 'on', participating: true, reason: 'rule:0' },
	},
};

function stubEnv(store: Record<string, string>): void {
	vi.stubGlobal('location', {
		href: `${HOST}/`,
		hostname: 'shop.example.com',
		pathname: '/pricing',
		search: '',
	});
	vi.stubGlobal('document', { referrer: '' });
	vi.stubGlobal('navigator', { language: 'en-US' });
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store[k] ?? null,
		setItem: (k: string, v: string) => {
			store[k] = v;
		},
	});
}

function stubEvalFetch(captured: { body?: Record<string, unknown> }): void {
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init?: RequestInit) => {
			if (String(url).includes('/api/flags/eval')) {
				captured.body = JSON.parse(String(init?.body ?? '{}'));
				return Promise.resolve(new Response(JSON.stringify(EVAL_RESPONSE)));
			}
			return Promise.resolve(new Response(null, { status: 202 }));
		}),
	);
}

describe('flags client', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it('evaluates on the server and reads back variants + participation', async () => {
		const store: Record<string, string> = {
			'facet.exp': 'deadbeefdeadbeef',
		};
		stubEnv(store);
		const captured: { body?: Record<string, unknown> } = {};
		stubEvalFetch(captured);

		const facet = await import('../src/index.js');
		facet.init({ host: HOST, siteId: SITE });
		await facet.whenFlagsReady();

		expect(facet.flag('new-checkout')).toBe('treatment');
		expect(facet.flagBool('dark-mode')).toBe(true);
		expect(facet.flagAssignment('new-checkout')).toMatchObject({
			participating: true,
			reason: 'rollout',
		});

		// Sends the stable local id + non-identifying ctx; never geo/device (server-authoritative).
		expect(captured.body?.id).toBe('deadbeefdeadbeef');
		expect(captured.body?.site_id).toBe(SITE);
		const ctx = captured.body?.ctx as Record<string, string>;
		expect(ctx.path).toBe('/pricing');
		expect(ctx.host).toBe('shop.example.com');
		expect(ctx).not.toHaveProperty('country');
		expect(ctx).not.toHaveProperty('device');
	});

	it('an unknown flag reads as a safe, non-participating default', async () => {
		stubEnv({ 'facet.exp': 'cafecafecafecafe' });
		stubEvalFetch({});
		const facet = await import('../src/index.js');
		facet.init({ host: HOST, siteId: SITE });
		await facet.whenFlagsReady();

		expect(facet.flag('does-not-exist')).toBe('');
		expect(facet.flagBool('does-not-exist')).toBe(false);
		expect(facet.flagAssignment('does-not-exist').reason).toBe('unknown');
	});

	it('never evaluates when opted out; every flag reads as its safe default', async () => {
		stubEnv({ 'facet.exp': 'aaaabbbbccccdddd', 'facet.optout': '1' });
		const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
		vi.stubGlobal('fetch', fetchMock);

		const facet = await import('../src/index.js');
		facet.init({ host: HOST, siteId: SITE });
		await facet.whenFlagsReady();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(facet.flagBool('new-checkout')).toBe(false);
		expect(facet.flagAssignment('new-checkout').reason).toBe('opted-out');
	});
});
