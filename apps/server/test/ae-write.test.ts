// The Analytics Engine mirror. Proves the positional layout (which is append-only and unmigratable,
// so a reorder is a silent data corruption), that every possible event fits inside AE's per-data-point
// limits, that an unbound binding is a no-op, and that ingest writes exactly one data point per
// accepted event — and none for a bot.

import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { NewEvent } from '../src/db/queries.js';
import type { Env } from '../src/env.js';
import {
	AE_RETENTION_DAYS,
	MAX_BLOBS,
	MAX_BLOB_BYTES,
	MAX_DOUBLES,
	MAX_INDEX_BYTES,
	clampBytes,
	eventBlobs,
	eventDoubles,
	writeEvent,
} from '../src/lib/ae.js';
import { deriveEvent } from '../src/lib/ingest.js';

const SITE = '99999999-9999-4999-8999-999999999999';
const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** A minimal event: only the non-nullable columns set, so every nullable slot exercises the null path. */
function minimalEvent(over: Partial<NewEvent> = {}): NewEvent {
	return {
		siteId: SITE,
		hostname: 'shop.example.com',
		path: '/checkout',
		referrer: '',
		name: null,
		props: null,
		visitorHash: 'abc123',
		country: null,
		device: null,
		createdAt: Date.UTC(2026, 6, 15, 12),
		...over,
	};
}

/** An event with every mirrored column past its cap, in 3-byte characters — the worst case for the
 * blob budget, since a character-based cap would pass three times its byte allowance. */
function maximalEvent(): NewEvent {
	const wide = '設'.repeat(4096);
	return {
		siteId: SITE,
		hostname: wide,
		path: `/${wide}`,
		referrer: wide,
		name: wide,
		props: null,
		visitorHash: wide,
		country: wide,
		device: wide,
		createdAt: 0,
		utmSource: wide,
		utmMedium: wide,
		utmCampaign: wide,
		channel: wide,
		browser: wide,
		os: wide,
		formFactor: wide,
		region: wide,
		city: wide,
		timezone: wide,
		network: wide,
		connection: wide,
		language: wide,
		screenTier: wide,
		orientation: wide,
		dprClass: wide,
		value: 12.5,
		currency: wide,
	};
}

function fakeAeEnv(retention = String(AE_RETENTION_DAYS)): {
	env: Env;
	writeDataPoint: ReturnType<typeof vi.fn>;
} {
	const writeDataPoint = vi.fn();
	return {
		env: {
			AE: { writeDataPoint },
			AE_BEST_EFFORT_ENABLED: 'true',
			RAW_RETENTION_DAYS: retention,
		} as unknown as Env,
		writeDataPoint,
	};
}

function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

const baseIngestInput = {
	siteId: SITE,
	ip: '203.0.113.9',
	ua: UA,
	hostname: 'shop.example.com',
	path: '/pricing',
	referrer: '',
	name: null,
	props: null,
	utm: null,
	country: 'US',
	device: 'desktop',
	now: Date.UTC(2026, 6, 15, 12),
	gpc: false,
	url: new URL('https://facet.example/api/collect'),
	uid: null,
	consent: false,
};

describe('clampBytes', () => {
	it('leaves a value inside the budget untouched', () => {
		expect(clampBytes('/checkout', 1024)).toBe('/checkout');
	});

	it('truncates on a byte budget, not a character count', () => {
		// 10 three-byte characters = 30 bytes; a 10-byte budget keeps 3 of them, not 10.
		expect(clampBytes('設'.repeat(10), 10)).toBe('設'.repeat(3));
	});

	it('never splits a multi-byte code point', () => {
		for (let max = 0; max <= 12; max++) {
			const out = clampBytes('a設b🎯c', max);
			expect(byteLength(out)).toBeLessThanOrEqual(max);
			// A split surrogate pair or truncated sequence decodes back as U+FFFD.
			expect(out).not.toContain('�');
		}
	});

	it('returns empty when the budget cannot fit even one code point', () => {
		expect(clampBytes('設', 2)).toBe('');
	});
});

describe('AE event layout', () => {
	it('maps each column to its documented blob position', () => {
		const blobs = eventBlobs(
			minimalEvent({
				referrer: 'https://news.example/a',
				name: 'purchase',
				country: 'US',
				device: 'desktop',
				channel: 'organic_search',
				browser: 'Chrome',
				os: 'macOS',
				formFactor: 'desktop',
				region: 'CA',
				city: 'San Francisco',
				timezone: 'America/Los_Angeles',
				network: 'Cloudflare',
				language: 'en',
				utmSource: 'newsletter',
				utmMedium: 'email',
				utmCampaign: 'summer',
				currency: 'USD',
			}),
		);
		expect(blobs).toEqual([
			'shop.example.com',
			'/checkout',
			'https://news.example/a',
			'purchase',
			'abc123',
			'US',
			'desktop',
			'organic_search',
			'Chrome',
			'macOS',
			'desktop',
			'CA',
			'San Francisco',
			'America/Los_Angeles',
			'Cloudflare',
			'en',
			'newsletter',
			'email',
			'summer',
			'USD',
		]);
	});

	it('writes an absent dimension as the empty string, since AE has no NULL', () => {
		const blobs = eventBlobs(minimalEvent());
		expect(blobs[5]).toBe('');
		expect(blobs[19]).toBe('');
		expect(blobs.every((b) => typeof b === 'string')).toBe(true);
	});

	it('reports revenue, a revenue indicator, and a pageview indicator', () => {
		expect(eventDoubles(minimalEvent())).toEqual([0, 0, 1]);
		expect(eventDoubles(minimalEvent({ name: 'purchase', value: 49.99 }))).toEqual([
			49.99, 1, 0,
		]);
		// A genuine zero-value purchase stays distinguishable from an event carrying no value at all.
		expect(eventDoubles(minimalEvent({ name: 'purchase', value: 0 }))).toEqual([0, 1, 0]);
	});

	it('drops a non-finite value rather than writing NaN into the column', () => {
		expect(eventDoubles(minimalEvent({ value: Number.NaN }))).toEqual([0, 0, 1]);
		expect(eventDoubles(minimalEvent({ value: Number.POSITIVE_INFINITY }))).toEqual([0, 0, 1]);
	});

	it('keeps the worst-case event inside every AE per-data-point limit', () => {
		const row = maximalEvent();
		const blobs = eventBlobs(row);
		expect(blobs.length).toBeLessThanOrEqual(MAX_BLOBS);
		expect(eventDoubles(row).length).toBeLessThanOrEqual(MAX_DOUBLES);
		expect(blobs.reduce((n, b) => n + byteLength(b), 0)).toBeLessThanOrEqual(MAX_BLOB_BYTES);
		expect(byteLength(clampBytes(row.siteId, MAX_INDEX_BYTES))).toBeLessThanOrEqual(
			MAX_INDEX_BYTES,
		);
	});
});

describe('writeEvent', () => {
	it('no-ops when the binding is absent', () => {
		expect(() => writeEvent({} as Env, minimalEvent())).not.toThrow();
	});

	it('indexes on the site, so sampling stays per-tenant', () => {
		const { env: fake, writeDataPoint } = fakeAeEnv();
		writeEvent(fake, minimalEvent());
		expect(writeDataPoint).toHaveBeenCalledOnce();
		expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({ indexes: [SITE] });
	});

	it('refuses to mirror when the deployment keeps raw data for less than AE does', () => {
		// AE has no delete API, so a mirrored copy would outlive the window the operator configured.
		const { env: fake, writeDataPoint } = fakeAeEnv(String(AE_RETENTION_DAYS - 1));
		writeEvent(fake, minimalEvent());
		expect(writeDataPoint).not.toHaveBeenCalled();
	});

	it('mirrors at exactly AE’s own window, and for a longer one', () => {
		for (const days of [String(AE_RETENTION_DAYS), String(AE_RETENTION_DAYS + 275)]) {
			const { env: fake, writeDataPoint } = fakeAeEnv(days);
			writeEvent(fake, minimalEvent());
			expect(writeDataPoint).toHaveBeenCalledOnce();
		}
	});

	it('falls back to the default window when RAW_RETENTION_DAYS is unusable, not to no gate', () => {
		// An unparseable var must resolve to the same 90 days retention enforces — not to 0 (which
		// would block every mirror) and not to NaN (which would slip past a `<` comparison entirely).
		for (const bad of ['', 'thirty', '-5', '0']) {
			const { env: fake, writeDataPoint } = fakeAeEnv(bad);
			writeEvent(fake, minimalEvent());
			expect(writeDataPoint).toHaveBeenCalledOnce();
		}
	});

	it('never lets a rejected data point fail the event that produced it', () => {
		const writeDataPoint = vi.fn(() => {
			throw new Error('limit exceeded');
		});
		const fake = { AE: { writeDataPoint }, AE_BEST_EFFORT_ENABLED: 'true' } as unknown as Env;
		expect(() => writeEvent(fake, minimalEvent())).not.toThrow();
	});
});

describe('ingest → AE', () => {
	it('mirrors exactly one data point per accepted event', async () => {
		const writeDataPoint = vi.fn();
		const derived = await deriveEvent(
			{ ...env, AE: { writeDataPoint }, AE_BEST_EFFORT_ENABLED: 'true' } as unknown as Env,
			baseIngestInput,
		);
		expect(derived).not.toBeNull();
		expect(writeDataPoint).toHaveBeenCalledOnce();
		const call = writeDataPoint.mock.calls[0]?.[0] as { blobs: string[]; doubles: number[] };
		expect(call.blobs[1]).toBe('/pricing');
		// The mirrored hash is the SAME derived value the D1 row carries — no second identifier.
		expect(call.blobs[4]).toBe(derived?.row.visitorHash);
		expect(call.doubles[2]).toBe(1);
	});

	it('writes nothing for a dropped bot', async () => {
		const writeDataPoint = vi.fn();
		const derived = await deriveEvent(
			{ ...env, AE: { writeDataPoint }, AE_BEST_EFFORT_ENABLED: 'true' } as unknown as Env,
			{
				...baseIngestInput,
				ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)',
			},
		);
		expect(derived).toBeNull();
		expect(writeDataPoint).not.toHaveBeenCalled();
	});
});
