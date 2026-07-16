// T015: track() builds a schema-valid CollectPayload (site_id/hostname/path/referrer + optional
// name/props) and sends it via sendBeacon, falling back to fetch(keepalive). No-op before init().

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SITE = '11111111-1111-4111-8111-111111111111';

function stubPage(search = ''): void {
	vi.stubGlobal('location', {
		href: `https://shop.example.com/pricing${search}`,
		hostname: 'shop.example.com',
		pathname: '/pricing',
		search,
	});
	vi.stubGlobal('document', { referrer: 'https://google.com/' });
}

describe('track', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it('sends a schema-valid beacon with site_id, hostname, path, name, and props', async () => {
		const sent: Array<{ url: string; body: string }> = [];
		stubPage();
		vi.stubGlobal('navigator', {
			sendBeacon: (url: string, blob: Blob) => {
				void blob.text().then((t) => sent.push({ url, body: t }));
				return true;
			},
		});

		const { init, track } = await import('../src/index.js');
		init({ host: 'https://analytics.example.com', siteId: SITE });
		track('signup', { plan: 'pro' });
		await new Promise((r) => setTimeout(r, 0));

		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe('https://analytics.example.com/api/collect');
		const body = JSON.parse(sent[0]?.body ?? '{}') as Record<string, unknown>;
		expect(body.site_id).toBe(SITE);
		expect(body.hostname).toBe('shop.example.com');
		expect(body.path).toBe('/pricing');
		expect(body.name).toBe('signup');
		expect(body.props).toEqual({ plan: 'pro' });
		// Structural contract: referrer present and path is absolute (server requires /^\//).
		expect(typeof body.referrer).toBe('string');
		expect(String(body.path).startsWith('/')).toBe(true);
	});

	it('falls back to fetch(keepalive) when sendBeacon is unavailable', async () => {
		stubPage();
		const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
		vi.stubGlobal('navigator', {});
		vi.stubGlobal('fetch', fetchMock);

		const { init, track } = await import('../src/index.js');
		init({ host: 'https://analytics.example.com', siteId: SITE });
		track();
		await new Promise((r) => setTimeout(r, 0));

		expect(fetchMock).toHaveBeenCalledOnce();
		const [, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(opts.keepalive).toBe(true);
		expect(opts.method).toBe('POST');
	});

	it('does nothing when called before init()', async () => {
		stubPage();
		const beacon = vi.fn(() => true);
		vi.stubGlobal('navigator', { sendBeacon: beacon });
		const { track } = await import('../src/index.js');
		track('signup');
		await new Promise((r) => setTimeout(r, 0));
		expect(beacon).not.toHaveBeenCalled();
	});
});
