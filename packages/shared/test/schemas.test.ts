import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CollectPayload } from '../src/events.js';
import { type CollectInput, CollectPayloadSchema } from '../src/schemas.js';

describe('CollectPayloadSchema', () => {
	const validPayload = {
		site_id: '123e4567-e89b-12d3-a456-426614174000',
		hostname: 'example.com',
		path: '/about',
		referrer: 'https://google.com',
		name: 'pageview',
		props: {
			theme: 'dark',
		},
	};

	it('parses valid payload', () => {
		expect(() => v.parse(CollectPayloadSchema, validPayload)).not.toThrow();
	});

	it('throws on non-UUID site_id', () => {
		expect(() =>
			v.parse(CollectPayloadSchema, { ...validPayload, site_id: 'not-a-uuid' }),
		).toThrow();
	});

	it('throws on name of 129 chars', () => {
		expect(() =>
			v.parse(CollectPayloadSchema, { ...validPayload, name: 'a'.repeat(129) }),
		).toThrow();
	});

	it('throws on path without leading /', () => {
		expect(() => v.parse(CollectPayloadSchema, { ...validPayload, path: 'about' })).toThrow();
	});

	it('throws on props with 25 keys', () => {
		const props: Record<string, string> = {};
		for (let i = 0; i < 25; i++) {
			props[`key${i}`] = 'value';
		}
		expect(() => v.parse(CollectPayloadSchema, { ...validPayload, props })).toThrow();
	});

	it('throws on props string value of 501 chars', () => {
		expect(() =>
			v.parse(CollectPayloadSchema, {
				...validPayload,
				props: { long: 'a'.repeat(501) },
			}),
		).toThrow();
	});

	it('type-level expectTypeOf holds', () => {
		expectTypeOf<CollectInput>().toMatchTypeOf<CollectPayload>();
	});
});
