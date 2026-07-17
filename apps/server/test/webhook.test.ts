// E.20: optional anomaly webhook — disabled without WEBHOOK_URL, HMAC-signed when a secret is set,
// best-effort (never throws), and fired once per anomaly by the scheduled notifier.

import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { insertEvent } from '../src/db/queries.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import type { Env } from '../src/env.js';
import {
	type AnomalyWebhookPayload,
	deliverAnomalyWebhook,
	notifyAnomalies,
} from '../src/lib/webhook.js';

const PAYLOAD: AnomalyWebhookPayload = {
	type: 'anomaly',
	site_id: 'site-1',
	metric: 'pageviews',
	bucket: 1,
	direction: 'drop',
	z: -4.2,
	value: 1,
	baseline_mean: 42,
	summary: 'Pageviews dropped 98% in the last hour (z=-4.2).',
	delivered_at: 2,
};

function recorder() {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchImpl = vi.fn((url: string, init: RequestInit) => {
		calls.push({ url, init });
		return Promise.resolve({ ok: true, status: 200 });
	});
	return { calls, fetchImpl };
}

describe('deliverAnomalyWebhook', () => {
	it('no-ops (no fetch) when WEBHOOK_URL is unset', async () => {
		const { calls, fetchImpl } = recorder();
		const ok = await deliverAnomalyWebhook(env as Env, PAYLOAD, fetchImpl as never);
		expect(ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it('POSTs a signed payload when URL + secret are set', async () => {
		const { calls, fetchImpl } = recorder();
		const cfg = {
			...env,
			WEBHOOK_URL: 'https://hook.example.com',
			WEBHOOK_SECRET: 'sekret',
		} as Env;
		const ok = await deliverAnomalyWebhook(cfg, PAYLOAD, fetchImpl as never);
		expect(ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://hook.example.com');
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers['X-Facet-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual(PAYLOAD);
	});

	it('omits the signature when no secret is configured', async () => {
		const { calls, fetchImpl } = recorder();
		const cfg = { ...env, WEBHOOK_URL: 'https://hook.example.com' } as Env;
		await deliverAnomalyWebhook(cfg, PAYLOAD, fetchImpl as never);
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers['X-Facet-Signature']).toBeUndefined();
	});

	it('never throws when delivery fails', async () => {
		const cfg = { ...env, WEBHOOK_URL: 'https://hook.example.com' } as Env;
		const failing = (() => Promise.reject(new Error('network'))) as never;
		await expect(deliverAnomalyWebhook(cfg, PAYLOAD, failing)).resolves.toBe(false);
	});
});

describe('notifyAnomalies', () => {
	it('no-ops when WEBHOOK_URL is unset', async () => {
		const { calls, fetchImpl } = recorder();
		await notifyAnomalies(env as Env, Date.now(), fetchImpl as never);
		expect(calls).toHaveLength(0);
	});

	it('delivers one webhook for a real last-completed-hour anomaly', async () => {
		const site = '66666666-6666-4666-8666-666666666666';
		const H = 3_600_000;
		const now = Date.UTC(2026, 6, 2, 0, 0, 0, 0);
		const base = now - 24 * H; // the notifier scans the trailing 24h window
		await db(env)
			.insert(schema.sites)
			.values({ id: site, name: 'S', domain: 's.com', createdAt: base });
		const jitter = [4, 5, 3];
		const seedHour = async (bucket: number, count: number) => {
			for (let i = 0; i < count; i++) {
				await insertEvent(env, {
					siteId: site,
					hostname: 's.com',
					path: '/',
					referrer: '',
					name: null,
					props: null,
					visitorHash: `v-${bucket}-${i}`,
					country: 'US',
					device: 'desktop',
					createdAt: bucket + i * 60_000,
				});
			}
		};
		// Fill all 23 completed baseline hours of the window (~4/h jittered), then a sharp drop in the
		// last completed hour (base + 23h). No empty hours, so the baseline stddev is nonzero.
		for (let h = 0; h < 23; h++) {
			await seedHour(base + h * H, jitter[h % 3] ?? 4);
		}
		// The last completed hour has a single pageview (a sharp drop from the ~4/h baseline).
		await seedHour(base + 23 * H, 1);
		const { calls, fetchImpl } = recorder();
		const cfg = {
			...env,
			WEBHOOK_URL: 'https://hook.example.com',
			WEBHOOK_SECRET: 's',
		} as Env;
		await notifyAnomalies(cfg, now, fetchImpl as never);
		const forSite = calls.filter((c) => JSON.parse(String(c.init.body)).site_id === site);
		expect(forSite).toHaveLength(1);
		expect(JSON.parse(String(forSite[0]?.init.body)).direction).toBe('drop');
	});
});
