// Visitor hash: format, determinism, sensitivity to every argument, and a pinned digest.

import { describe, expect, it } from 'vitest';
import { visitorHash } from '../src/lib/hash.js';

const IP = '1.2.3.4';
const UA = 'Mozilla/5.0';
const SALT = 'deadbeef';
const SITE = 'site-123';
const PINNED = 'd9ff6171295845dd79afc87d3aeb7f6a2d78406b3cf139842bdc54defa75fa8b';

describe('visitorHash', () => {
	it('is 64 lowercase hex and deterministic', async () => {
		const a = await visitorHash(IP, UA, SALT, SITE);
		const b = await visitorHash(IP, UA, SALT, SITE);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it('matches the pinned digest for a fixed 4-tuple', async () => {
		expect(await visitorHash(IP, UA, SALT, SITE)).toBe(PINNED);
	});

	it('changes when any single argument changes', async () => {
		const base = await visitorHash(IP, UA, SALT, SITE);
		expect(await visitorHash('9.9.9.9', UA, SALT, SITE)).not.toBe(base);
		expect(await visitorHash(IP, 'other-ua', SALT, SITE)).not.toBe(base);
		expect(await visitorHash(IP, UA, 'cafebabe', SITE)).not.toBe(base);
		expect(await visitorHash(IP, UA, SALT, 'site-999')).not.toBe(base);
	});
});
