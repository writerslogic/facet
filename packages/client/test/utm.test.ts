import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('utm tracking', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('includes utm object in beacon body when utm params present', async () => {
		const sent: string[] = [];

		vi.stubGlobal('location', {
			href: 'https://example.com/page?utm_source=nl&utm_medium=email',
			search: '?utm_source=nl&utm_medium=email',
		});
		vi.stubGlobal('document', { referrer: '' });
		vi.stubGlobal('navigator', {
			sendBeacon: (_url: string, blob: Blob) => {
				void blob.text().then((t) => sent.push(t));
				return true;
			},
		});

		const { init, track } = await import('../src/index.js');
		init({ host: 'https://analytics.example.com', siteId: 'site-1' });
		track();

		// Wait for blob.text() microtask
		await new Promise((r) => setTimeout(r, 0));

		expect(sent).toHaveLength(1);
		const body = JSON.parse(sent[0] as string) as Record<string, unknown>;
		expect(body.utm).toEqual({ source: 'nl', medium: 'email' });
	});

	it('omits utm key when no utm params present', async () => {
		const sent: string[] = [];

		vi.stubGlobal('location', { href: 'https://example.com/page', search: '' });
		vi.stubGlobal('document', { referrer: '' });
		vi.stubGlobal('navigator', {
			sendBeacon: (_url: string, blob: Blob) => {
				void blob.text().then((t) => sent.push(t));
				return true;
			},
		});

		const { init, track } = await import('../src/index.js');
		init({ host: 'https://analytics.example.com', siteId: 'site-1' });
		track();

		await new Promise((r) => setTimeout(r, 0));

		expect(sent).toHaveLength(1);
		const body = JSON.parse(sent[0] as string) as Record<string, unknown>;
		expect(body).not.toHaveProperty('utm');
	});
});
