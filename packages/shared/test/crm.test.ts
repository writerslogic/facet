import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { DealCreateSchema, DealUpdateSchema } from '../src/crm.js';

// `value: 0` is a legitimate, schema-permitted deal amount (a free trial won at $0, say). moneyIsPaired
// used to test presence with `Boolean(b.value)`, and `Boolean(0)` is false, so a correctly-paired
// `{value: 0, currency: 'USD'}` was rejected as if currency had been supplied alone.
describe('DealCreateSchema money pairing', () => {
	it('accepts value: 0 paired with a currency', () => {
		expect(() =>
			v.parse(DealCreateSchema, { name: 'Trial', value: 0, currency: 'USD' }),
		).not.toThrow();
	});

	it('still rejects value: 0 with no currency', () => {
		expect(() => v.parse(DealCreateSchema, { name: 'Trial', value: 0 })).toThrow();
	});

	it('still rejects a currency with no value', () => {
		expect(() => v.parse(DealCreateSchema, { name: 'Trial', currency: 'USD' })).toThrow();
	});

	it('accepts neither value nor currency', () => {
		expect(() => v.parse(DealCreateSchema, { name: 'Trial' })).not.toThrow();
	});
});

describe('DealUpdateSchema money pairing', () => {
	it('accepts value: 0 paired with a currency', () => {
		expect(() => v.parse(DealUpdateSchema, { value: 0, currency: 'USD' })).not.toThrow();
	});

	it('still rejects value: 0 with no currency', () => {
		expect(() => v.parse(DealUpdateSchema, { value: 0 })).toThrow();
	});
});
