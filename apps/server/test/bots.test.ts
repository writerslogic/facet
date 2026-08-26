// Bot filtering: known crawlers and empty/whitespace UAs are bots; real browsers are not. The
// operator-refreshed ruleset is additive only — no refresh can un-bot a UA the compiled-in list drops.

import { afterEach, describe, expect, it } from 'vitest';
import {
	MAX_PATTERNS,
	MAX_PATTERN_LENGTH,
	compilePatterns,
	isBot,
	primeBotPatterns,
	resetBotPatterns,
	validateRulesetPayload,
} from '../src/lib/bots.js';

const CHROME =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The pattern cache is isolate-global, so every case starts from the compiled-in floor.
afterEach(() => {
	resetBotPatterns();
});

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

	it('flags a UA matched only by a refreshed pattern', () => {
		const ua = `${CHROME} AcmeInternal/1.0`;
		expect(isBot(ua)).toBe(false);
		primeBotPatterns(['acmeinternal/'], 'k1', 1);
		expect(isBot(ua)).toBe(true);
	});

	it('never un-bots a crawler, whatever the refreshed set contains', () => {
		primeBotPatterns([], 'empty', 1);
		expect(isBot('Googlebot/2.1')).toBe(true);
		expect(isBot('')).toBe(true);
		primeBotPatterns(['(((', 'not-a-regex[', '\\'], 'garbage', 2);
		expect(isBot('Googlebot/2.1')).toBe(true);
		expect(isBot(CHROME)).toBe(false);
	});
});

describe('validateRulesetPayload', () => {
	it('accepts a JSON array of bounded strings', () => {
		expect(validateRulesetPayload(['bot', 'crawler'])).toEqual(['bot', 'crawler']);
	});

	it('rejects a non-array, and an array holding a non-string', () => {
		expect(validateRulesetPayload({ patterns: ['bot'] })).toBeNull();
		expect(validateRulesetPayload(['bot', 42])).toBeNull();
	});

	it('rejects the whole payload past the count limit', () => {
		expect(validateRulesetPayload(new Array(MAX_PATTERNS).fill('bot'))).toHaveLength(
			MAX_PATTERNS,
		);
		expect(validateRulesetPayload(new Array(MAX_PATTERNS + 1).fill('bot'))).toBeNull();
	});

	it('rejects the whole payload for one over-long pattern', () => {
		expect(validateRulesetPayload(['a'.repeat(MAX_PATTERN_LENGTH)])).toHaveLength(1);
		expect(
			validateRulesetPayload(['bot', 'a'.repeat(MAX_PATTERN_LENGTH + 1), 'crawler']),
		).toBeNull();
	});
});

describe('match bound', () => {
	// The ReDoS bound. Screening pattern SHAPES misses `((a+))+` and `(a|a)+`, and backtracking blows
	// up in the length of the subject, so what actually caps the loop is how much of an
	// attacker-controlled user-agent a refreshed pattern is ever allowed to see.
	it('never matches a refreshed pattern past the bounded prefix', () => {
		// Padded onto a real browser UA so the compiled-in floor is not what decides the case.
		const ua = (total: number) =>
			`${CHROME} ${'a'.repeat(total - CHROME.length - 'needle'.length - 1)}needle`;
		primeBotPatterns(['needle'], 'k', 0);
		expect(isBot(ua(400))).toBe(true);
		expect(isBot(ua(600))).toBe(false);
	});
});

describe('compilePatterns', () => {
	it('drops a ReDoS-shaped pattern and keeps the valid ones', () => {
		const compiled = compilePatterns(['goodbot', '(a+)+$', '(?:x*)*', 'otherbot']);
		expect(compiled.map((r) => r.source)).toEqual(['goodbot', 'otherbot']);
	});

	it('drops an over-broad pattern that would flag a plain browser', () => {
		expect(compilePatterns(['goodbot', '.*', '.']).map((r) => r.source)).toEqual(['goodbot']);
	});

	it('drops an uncompilable pattern without failing the set', () => {
		const compiled = compilePatterns(['goodbot', '(((', 'otherbot']);
		expect(compiled.map((r) => r.source)).toEqual(['goodbot', 'otherbot']);
	});
});
