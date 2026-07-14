// T010: bot filtering — known crawlers and empty/whitespace UAs are bots; real browsers are not.

import { describe, expect, it } from 'vitest';
import { isBot } from '../src/lib/bots.js';

const CHROME =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

describe('isBot', () => {
	it('flags known crawlers', () => {
		expect(isBot('Googlebot/2.1')).toBe(true);
	});

	it('flags empty and whitespace-only user-agents', () => {
		expect(isBot('')).toBe(true);
		expect(isBot('   ')).toBe(true);
	});

	it('passes a normal desktop Chrome UA', () => {
		expect(isBot(CHROME)).toBe(false);
	});
});
