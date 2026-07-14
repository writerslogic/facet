import { describe, expect, it } from 'vitest';
import { classifyChannel, parseUtm } from '../src/lib/channel.js';
import type { Channel } from '../src/lib/channel.js';

interface TestCase {
	description: string;
	referrer: string;
	search: string;
	siteHostname: string;
	expected: Channel;
}

const cases: TestCase[] = [
	{
		description: 'utm_medium=cpc → paid',
		referrer: '',
		search: '?utm_medium=cpc',
		siteHostname: 'example.com',
		expected: 'paid',
	},
	{
		description: 'utm_medium=ppc → paid',
		referrer: '',
		search: '?utm_medium=ppc',
		siteHostname: 'example.com',
		expected: 'paid',
	},
	{
		description: 'utm_medium=display → paid',
		referrer: '',
		search: '?utm_medium=display',
		siteHostname: 'example.com',
		expected: 'paid',
	},
	{
		description: 'utm_medium=email → email',
		referrer: '',
		search: '?utm_medium=email',
		siteHostname: 'example.com',
		expected: 'email',
	},
	{
		description: 'utm_source=newsletter → email',
		referrer: '',
		search: '?utm_source=newsletter',
		siteHostname: 'example.com',
		expected: 'email',
	},
	{
		description: 'utm_medium=social → social',
		referrer: '',
		search: '?utm_medium=social',
		siteHostname: 'example.com',
		expected: 'social',
	},
	{
		description: 'referrer=twitter.com → social',
		referrer: 'https://twitter.com/some/path',
		search: '',
		siteHostname: 'example.com',
		expected: 'social',
	},
	{
		description: 'referrer=reddit.com → social',
		referrer: 'https://reddit.com/r/programming',
		search: '',
		siteHostname: 'example.com',
		expected: 'social',
	},
	{
		description: 'referrer=google.com → organic',
		referrer: 'https://google.com/search?q=test',
		search: '',
		siteHostname: 'example.com',
		expected: 'organic',
	},
	{
		description: 'referrer=www.google.com → organic',
		referrer: 'https://www.google.com/search?q=test',
		search: '',
		siteHostname: 'example.com',
		expected: 'organic',
	},
	{
		description: 'referrer=bing.com → organic',
		referrer: 'https://bing.com/search?q=test',
		search: '',
		siteHostname: 'example.com',
		expected: 'organic',
	},
	{
		description: 'referrer=duckduckgo.com → organic',
		referrer: 'https://duckduckgo.com/?q=test',
		search: '',
		siteHostname: 'example.com',
		expected: 'organic',
	},
	{
		description: 'empty referrer → direct',
		referrer: '',
		search: '',
		siteHostname: 'example.com',
		expected: 'direct',
	},
	{
		description: 'same-host referrer → internal',
		referrer: 'https://example.com/other-page',
		search: '',
		siteHostname: 'example.com',
		expected: 'internal',
	},
	{
		description: 'unknown referrer → referral',
		referrer: 'https://someotherblog.com/post',
		search: '',
		siteHostname: 'example.com',
		expected: 'referral',
	},
	{
		description: 'paid takes priority over social referrer',
		referrer: 'https://facebook.com/ad',
		search: '?utm_medium=cpc',
		siteHostname: 'example.com',
		expected: 'paid',
	},
	{
		description: 'utm_medium=paidsearch → paid',
		referrer: '',
		search: '?utm_medium=paidsearch',
		siteHostname: 'example.com',
		expected: 'paid',
	},
	{
		description: 'referrer=t.co → social',
		referrer: 'https://t.co/abc123',
		search: '',
		siteHostname: 'example.com',
		expected: 'social',
	},
	{
		description: 'referrer=yandex.ru → organic',
		referrer: 'https://yandex.ru/search/?text=test',
		search: '',
		siteHostname: 'example.com',
		expected: 'organic',
	},
];

describe('classifyChannel', () => {
	it.each(cases)('$description', ({ referrer, search, siteHostname, expected }) => {
		const utm = parseUtm(search);
		const result = classifyChannel({ referrer, utm, siteHostname });
		expect(result).toBe(expected);
	});
});

describe('parseUtm', () => {
	it('parses all three utm params', () => {
		const result = parseUtm('?utm_source=google&utm_medium=cpc&utm_campaign=summer');
		expect(result).toEqual({ source: 'google', medium: 'cpc', campaign: 'summer' });
	});

	it('returns null for missing params', () => {
		const result = parseUtm('');
		expect(result).toEqual({ source: null, medium: null, campaign: null });
	});
});
