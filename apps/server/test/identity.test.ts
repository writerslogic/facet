// Identity derivation core (U2). The load-bearing properties: the day window is a byte-for-byte
// superset of the legacy dayKey; the anonymous/pseudonymous hash is IDENTICAL to the legacy
// visitorHash (so a zero-config site is a proven no-op); ISO week keys use the week-NUMBERING year so
// they are stable across a calendar-year boundary; and the identified `uid:` pre-image can never
// collide with an anonymous one and is isolated per site.

import { describe, expect, it } from 'vitest';
import { visitorHash } from '../src/lib/hash.js';
import {
	buildPreimage,
	deriveVisitorHash,
	isoWeekKey,
	monthKey,
	windowKey,
} from '../src/lib/identity.js';
import { dayKey } from '../src/lib/salt.js';

const SALT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const SITE = '11111111-1111-4111-8111-111111111111';
const t = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m, d, h);

describe('windowKey', () => {
	it('day is a byte-for-byte superset of dayKey', () => {
		for (const ts of [t(2026, 0, 1), t(2026, 6, 17), t(2027, 11, 31, 23)]) {
			expect(windowKey('day', ts)).toBe(dayKey(ts));
		}
	});

	it('month is UTC YYYY-MM', () => {
		expect(windowKey('month', t(2026, 6, 17))).toBe('2026-07');
		expect(monthKey(t(2026, 0, 1))).toBe('2026-01');
	});
});

describe('isoWeekKey', () => {
	it('uses the ISO week-numbering year across a calendar-year boundary', () => {
		// 2026-12-31 (Thu), 2027-01-01 (Fri), 2027-01-03 (Sun) are all ISO week 2026-W53;
		// 2027-01-04 (Mon) starts 2027-W01.
		expect(isoWeekKey(t(2026, 11, 31))).toBe('2026-W53');
		expect(isoWeekKey(t(2027, 0, 1))).toBe('2026-W53');
		expect(isoWeekKey(t(2027, 0, 3))).toBe('2026-W53');
		expect(isoWeekKey(t(2027, 0, 4))).toBe('2027-W01');
	});

	it('is stable within a week and distinct across adjacent weeks', () => {
		// Mon 2026-07-13 .. Sun 2026-07-19 share one key; the next Monday differs.
		const week = [13, 14, 15, 16, 17, 18, 19].map((d) => isoWeekKey(t(2026, 6, d)));
		expect(new Set(week).size).toBe(1);
		expect(isoWeekKey(t(2026, 6, 20))).not.toBe(week[0]);
	});
});

describe('deriveVisitorHash', () => {
	it('anonymous is identical to the legacy visitorHash (zero-config no-op)', async () => {
		const legacy = await visitorHash('203.0.113.5', 'UA/1.0', SALT, SITE);
		const derived = await deriveVisitorHash(
			'anonymous',
			{ ip: '203.0.113.5', ua: 'UA/1.0' },
			SALT,
			SITE,
		);
		expect(derived).toBe(legacy);
	});

	it('pseudonymous keeps the ip|ua pre-image (same as anonymous for equal inputs)', async () => {
		const a = await deriveVisitorHash('pseudonymous', { ip: '1.2.3.4', ua: 'X' }, SALT, SITE);
		const b = await deriveVisitorHash('anonymous', { ip: '1.2.3.4', ua: 'X' }, SALT, SITE);
		expect(a).toBe(b);
	});

	it('identified uses the uid: namespace and never collides with an anonymous pre-image', () => {
		const anon = buildPreimage('anonymous', { ip: 'uid:bob', ua: '' }, SALT, SITE);
		const ident = buildPreimage('identified', { ip: '', ua: '', uid: 'bob' }, SALT, SITE);
		// Even a crafted anonymous ip of "uid:bob" cannot reproduce the identified pre-image.
		expect(ident).not.toBe(anon);
		expect(ident.startsWith('uid:bob')).toBe(true);
	});

	it('identified is isolated per site: same uid on two sites yields unrelated hashes', async () => {
		const s1 = await deriveVisitorHash(
			'identified',
			{ ip: '', ua: '', uid: 'bob' },
			SALT,
			SITE,
		);
		const s2 = await deriveVisitorHash(
			'identified',
			{ ip: '', ua: '', uid: 'bob' },
			SALT,
			'22222222-2222-4222-8222-222222222222',
		);
		expect(s1).not.toBe(s2);
	});

	it('falls back to the anonymous pre-image when identified has no uid', async () => {
		const noUid = await deriveVisitorHash('identified', { ip: '9.9.9.9', ua: 'Y' }, SALT, SITE);
		const anon = await deriveVisitorHash('anonymous', { ip: '9.9.9.9', ua: 'Y' }, SALT, SITE);
		expect(noUid).toBe(anon);
	});
});
