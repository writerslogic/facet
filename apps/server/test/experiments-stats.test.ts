// Experiment significance + aggregation. Unit-tests the two-proportion p-value against a pinned
// case, then seeds `$exposure` + goal events and asserts exact exposures/conversions/rate.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { experimentResult, twoProportionPValue } from '../src/db/experiments.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';

const SITE = '44444444-4444-4444-8444-444444444444';
const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const H = 3_600_000;

async function seedEvent(
	visitor: string,
	path: string,
	name: string | null,
	props: Record<string, unknown> | null,
	at: number,
): Promise<void> {
	await db(env)
		.insert(schema.events)
		.values({
			id: crypto.randomUUID(),
			siteId: SITE,
			hostname: 'exp.com',
			path,
			referrer: '',
			name,
			props: props ? JSON.stringify(props) : null,
			visitorHash: visitor,
			country: 'US',
			device: 'desktop',
			createdAt: at,
			channel: 'organic',
		});
}

describe('twoProportionPValue', () => {
	it('flags a clear difference as significant', () => {
		const p = twoProportionPValue(100, 1000, 150, 1000);
		expect(p).not.toBeNull();
		expect(p as number).toBeCloseTo(0.00072, 4);
		expect((p as number) < 0.05).toBe(true);
	});

	it('returns ~1 for equal proportions (not significant)', () => {
		const p = twoProportionPValue(100, 1000, 100, 1000);
		expect(p).not.toBeNull();
		expect(p as number).toBeCloseTo(1, 5);
		expect((p as number) < 0.05).toBe(false);
	});

	it('returns null when a sample is empty', () => {
		expect(twoProportionPValue(0, 0, 5, 10)).toBeNull();
		expect(twoProportionPValue(5, 10, 0, 0)).toBeNull();
	});
});

describe('experimentResult', () => {
	it('computes exposures, conversions, and rate per variant', async () => {
		const experiment = {
			id: 'exp-1',
			site_id: SITE,
			name: 'CTA color',
			flag_key: 'cta',
			variants: [
				{ key: 'control', weight: 1 },
				{ key: 'blue', weight: 1 },
			],
			active: true,
			created_at: T0,
		};

		// control: 2 exposures (a, b), 1 converts (a fires signup).
		await seedEvent('a', '/', '$exposure', { flag: 'cta', variant: 'control' }, T0);
		await seedEvent('a', '/thanks', 'signup', null, T0 + H);
		await seedEvent('b', '/', '$exposure', { flag: 'cta', variant: 'control' }, T0);

		// blue: 2 exposures (c, d), 2 convert.
		await seedEvent('c', '/', '$exposure', { flag: 'cta', variant: 'blue' }, T0);
		await seedEvent('c', '/thanks', 'signup', null, T0 + H);
		await seedEvent('d', '/', '$exposure', { flag: 'cta', variant: 'blue' }, T0);
		await seedEvent('d', '/thanks', 'signup', null, T0 + H);

		// Noise: a different flag's exposure must not count.
		await seedEvent('e', '/', '$exposure', { flag: 'other', variant: 'control' }, T0);

		const result = await experimentResult(
			env,
			experiment,
			{ type: 'event', value: 'signup' },
			{ siteId: SITE, start: T0, end: T0 + 24 * H },
		);

		const control = result.variants[0];
		const blue = result.variants[1];
		expect(control).toMatchObject({
			key: 'control',
			exposures: 2,
			conversions: 1,
			rate: 0.5,
			p_value: null,
			significant: false,
		});
		expect(blue).toMatchObject({
			key: 'blue',
			exposures: 2,
			conversions: 2,
			rate: 1,
		});
		expect(blue?.p_value).not.toBeNull();
	});
});
