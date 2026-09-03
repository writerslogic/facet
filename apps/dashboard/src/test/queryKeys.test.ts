// queryKeyReferencesSite is what App.tsx's site-switch effect uses to evict a leaving site's
// cached queries. It only works because siteQueryKey guarantees the site id lands as a literal
// key element — the one behavior worth pinning is that guarantee, for both a flat scope and a
// nested one (e.g. `['stats', 'content']`), and that an unrelated key never false-matches.

import { describe, expect, it } from 'vitest';
import { queryKeyReferencesSite, siteQueryKey } from '../lib/queryKeys.js';

describe('siteQueryKey / queryKeyReferencesSite', () => {
	it('places the site id right after a flat scope', () => {
		expect(siteQueryKey('cube', 'site-1', 'range', 'interval')).toEqual([
			'cube',
			'site-1',
			'range',
			'interval',
		]);
	});

	it('places the site id right after a nested scope', () => {
		expect(siteQueryKey(['stats', 'content'], 'site-1', { q: '' })).toEqual([
			'stats',
			'content',
			'site-1',
			{ q: '' },
		]);
	});

	it('matches a key built by the factory for that site', () => {
		const key = siteQueryKey(['stats', 'acquisition'], 'site-1', { interval: 'day' });
		expect(queryKeyReferencesSite(key, 'site-1')).toBe(true);
	});

	it('does not match a key built for a different site', () => {
		const key = siteQueryKey('cube', 'site-2', 'range');
		expect(queryKeyReferencesSite(key, 'site-1')).toBe(false);
	});

	it('does not match a key with no site id at all', () => {
		expect(queryKeyReferencesSite(['session', 'me'], 'site-1')).toBe(false);
	});
});
