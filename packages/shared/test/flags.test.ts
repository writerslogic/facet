// The shared flag evaluator. Load-bearing properties (all from the design's adversarial review): the
// bucket draw is deterministic + uniform + in [0,10000) computed in the BigInt integer domain (no
// float rounding), the gate is monotone with correct 0%/100% boundaries, variant selection covers the
// whole space, and evaluation is first-match with a kill switch. Bucketing keys on the caller's stable
// id, never a rotating hash, so repeated evaluation is stable.

import { describe, expect, it } from 'vitest';
import { type FlagConfig, bucket, evaluateFlag, inRollout, pickVariant } from '../src/flags.js';

const SALT = 'a1b2c3d4';

describe('bucket', () => {
	it('is deterministic and lands in [0, 10000)', async () => {
		const a = await bucket('id-1', 'flag', SALT, 0, 'ramp');
		const b = await bucket('id-1', 'flag', SALT, 0, 'ramp');
		expect(a).toBe(b);
		expect(Number.isInteger(a)).toBe(true);
		expect(a).toBeGreaterThanOrEqual(0);
		expect(a).toBeLessThan(10000);
	});

	it('is uniform: a 50/50 boolean split lands near half over many ids', async () => {
		let on = 0;
		const N = 3000;
		for (let i = 0; i < N; i++) {
			const p = await bucket(`id-${i}`, 'flag', SALT, 0, 'variant');
			if (p < 5000) on++;
		}
		expect(on / N).toBeGreaterThan(0.45);
		expect(on / N).toBeLessThan(0.55);
	});

	it('the ramp and variant namespaces are independent draws', async () => {
		// A visitor's rollout membership must not correlate with which variant they get.
		let diff = 0;
		for (let i = 0; i < 200; i++) {
			const r = await bucket(`id-${i}`, 'flag', SALT, 0, 'ramp');
			const v = await bucket(`id-${i}`, 'flag', SALT, 0, 'variant');
			if (r !== v) diff++;
		}
		expect(diff).toBeGreaterThan(190);
	});
});

describe('inRollout', () => {
	it('is monotone: raising the rollout only adds members', () => {
		const points = [0, 999, 1000, 2499, 2500, 5000, 9999];
		const at2500 = points.filter((p) => inRollout(p, 2500));
		const at5000 = points.filter((p) => inRollout(p, 5000));
		expect(at2500.every((p) => at5000.includes(p))).toBe(true);
	});

	it('has correct 0% and 100% boundaries', () => {
		for (const p of [0, 5000, 9999]) {
			expect(inRollout(p, 0)).toBe(false); // 0% => nobody
			expect(inRollout(p, 10000)).toBe(true); // 100% => everybody (points max at 9999)
		}
	});
});

describe('pickVariant', () => {
	it('selects by cumulative basis-point weight and covers the whole space', () => {
		const variants = [
			{ key: 'a', weight: 3000 },
			{ key: 'b', weight: 3000 },
			{ key: 'c', weight: 4000 },
		];
		expect(pickVariant(0, variants)).toBe('a');
		expect(pickVariant(2999, variants)).toBe('a');
		expect(pickVariant(3000, variants)).toBe('b');
		expect(pickVariant(5999, variants)).toBe('b');
		expect(pickVariant(6000, variants)).toBe('c');
		expect(pickVariant(9999, variants)).toBe('c');
	});

	it('a single 100% variant is always chosen', () => {
		const variants = [{ key: 'only', weight: 10000 }];
		for (const p of [0, 4321, 9999]) expect(pickVariant(p, variants)).toBe('only');
	});
});

const boolFlag = (over: Partial<FlagConfig> = {}): FlagConfig => ({
	flag_key: 'checkout',
	type: 'boolean',
	enabled: true,
	default_variant: 'off',
	variants: [
		{ key: 'on', weight: 5000 },
		{ key: 'off', weight: 5000 },
	],
	salt: SALT,
	rollout_seed: 0,
	version: 1,
	rules: [],
	...over,
});

describe('evaluateFlag', () => {
	it('a disabled flag serves the default and is not participating', async () => {
		const res = await evaluateFlag(boolFlag({ enabled: false }), {}, 'id-1');
		expect(res).toEqual({
			variant: 'off',
			participating: false,
			reason: 'disabled',
		});
	});

	it('is stable: repeated evaluation of the same id yields the same variant', async () => {
		const flag = boolFlag();
		const first = await evaluateFlag(flag, {}, 'id-42');
		const again = await evaluateFlag(flag, {}, 'id-42');
		expect(again.variant).toBe(first.variant);
		expect(again.reason).toBe('rollout');
	});

	it('applies the first matching rule by priority, ANDing its clauses', async () => {
		const flag = boolFlag({
			rules: [
				{
					priority: 10,
					clauses: [{ attr: 'country', op: 'eq', value: 'DE' }],
					serve: { variant: 'off' },
				},
				{
					priority: 0,
					clauses: [
						{ attr: 'country', op: 'eq', value: 'US' },
						{ attr: 'device', op: 'eq', value: 'mobile' },
					],
					serve: { variant: 'on' },
				},
			],
		});
		expect((await evaluateFlag(flag, { country: 'US', device: 'mobile' }, 'x')).variant).toBe(
			'on',
		);
		// AND fails (desktop) -> falls through to the DE rule? no (country US) -> base rollout.
		expect((await evaluateFlag(flag, { country: 'US', device: 'desktop' }, 'x')).reason).toBe(
			'rollout',
		);
		expect((await evaluateFlag(flag, { country: 'DE' }, 'x')).variant).toBe('off');
	});

	it('a pct clause is a sticky cohort gate over the ramp draw', async () => {
		// A rule that serves "on" to a sticky 100% cohort always matches; 0% never does.
		const always = boolFlag({
			rules: [
				{
					priority: 0,
					clauses: [{ attr: 'stableId', op: 'pct', value: 100 }],
					serve: { variant: 'on' },
				},
			],
		});
		expect((await evaluateFlag(always, {}, 'id-7')).variant).toBe('on');
		const never = boolFlag({
			rules: [
				{
					priority: 0,
					clauses: [{ attr: 'stableId', op: 'pct', value: 0 }],
					serve: { variant: 'on' },
				},
			],
		});
		expect((await evaluateFlag(never, {}, 'id-7')).reason).toBe('rollout');
	});

	it('a missing context attribute never matches (no accidental match)', async () => {
		const flag = boolFlag({
			rules: [
				{
					priority: 0,
					clauses: [{ attr: 'custom.plan', op: 'eq', value: 'pro' }],
					serve: { variant: 'on' },
				},
			],
		});
		expect((await evaluateFlag(flag, {}, 'id-1')).reason).toBe('rollout');
		expect((await evaluateFlag(flag, { custom: { plan: 'pro' } }, 'id-1')).variant).toBe('on');
	});
});
