// Deferred-commit exposure dedupe: the `exposed` marker is committed only on a server ack, so a failed
// $exposure send retries on the next assignment() instead of being silently suppressed, and the
// uncommitted set stays bounded when the collector is unreachable.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SITE = '11111111-1111-4111-8111-111111111111';
const HOST = 'https://analytics.example.com';

const ONE_FLAG = {
	experiments: [{ flag_key: 'cta', variants: [{ key: 'control', weight: 1 }] }],
};

// A failed exposure is held for EXPOSURE_RETRY_MS before it is retried, so a retry round has to move
// the clock; without that the bound under test would be the backoff rather than the queue cap.
const RETRY_BACKOFF_MS = 5_000;
let clock = 1_700_000_000_000;

function advancePastBackoff(): void {
	clock += RETRY_BACKOFF_MS + 1;
}

function stubEnv(): void {
	clock = 1_700_000_000_000;
	vi.spyOn(Date, 'now').mockImplementation(() => clock);
	const store: Record<string, string> = { 'facet.exp': 'deadbeefdeadbeef' };
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
	vi.stubGlobal('navigator', {});
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('exposure deferred commit', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it('leaves the exposure uncommitted when the send fails and commits it exactly once on the retry', async () => {
		stubEnv();
		const collected: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, opts?: RequestInit) => {
				if (String(url).includes('/api/experiments/active')) {
					return Promise.resolve(new Response(JSON.stringify(ONE_FLAG)));
				}
				collected.push(String(opts?.body ?? ''));
				return Promise.resolve(
					new Response(null, { status: collected.length === 1 ? 500 : 202 }),
				);
			}),
		);

		const { init } = await import('../src/index.js');
		const { assignment, whenReady } = await import('../src/experiments.js');
		init({ host: HOST, siteId: SITE });
		await whenReady();

		assignment('cta');
		await tick();
		expect(collected).toHaveLength(1);

		// Still inside the backoff: the failed exposure is held, not re-sent.
		assignment('cta');
		await tick();
		expect(collected).toHaveLength(1);

		advancePastBackoff();
		assignment('cta');
		await tick();
		expect(collected).toHaveLength(2);

		advancePastBackoff();
		assignment('cta');
		assignment('cta');
		await tick();
		expect(collected).toHaveLength(2);
		for (const body of collected) {
			const parsed = JSON.parse(body) as { name: string; props: { flag: string } };
			expect(parsed.name).toBe('$exposure');
			expect(parsed.props.flag).toBe('cta');
		}
	});

	it('bounds the uncommitted exposures under sustained send failure', async () => {
		stubEnv();
		const keys = Array.from({ length: 64 }, (_, i) => `f${i}`);
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, opts?: RequestInit) => {
				if (String(url).includes('/api/experiments/active')) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								experiments: keys.map((k) => ({
									flag_key: k,
									variants: [{ key: 'control', weight: 1 }],
								})),
							}),
						),
					);
				}
				const parsed = JSON.parse(String(opts?.body ?? '{}')) as {
					props: { flag: string };
				};
				seen.push(parsed.props.flag);
				return Promise.resolve(new Response(null, { status: 500 }));
			}),
		);

		const { init } = await import('../src/index.js');
		const { assignment, whenReady } = await import('../src/experiments.js');
		init({ host: HOST, siteId: SITE });
		await whenReady();

		for (const k of keys) assignment(k);
		expect(new Set(seen).size).toBe(32);
		expect(seen).toHaveLength(32);

		// Every send failed, so all 32 return to the uncommitted set; a further round of assignments
		// retries those and admits no more.
		await tick();
		seen.length = 0;
		advancePastBackoff();
		for (const k of keys) assignment(k);
		await tick();
		expect(new Set(seen).size).toBe(32);
		expect(seen).toHaveLength(32);
	});
});
