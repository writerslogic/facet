// Request metadata: device class from UA, country normalization, client IP header.

import { describe, expect, it } from 'vitest';
import { clientIp, country, device } from '../src/lib/request-meta.js';

function reqWith(headers: Record<string, string>): Request {
	return new Request('https://example.com/', { headers });
}

describe('device', () => {
	it('classifies iPhone as mobile, iPad as tablet, desktop otherwise', () => {
		expect(device('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mobile');
		expect(device('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
		expect(device('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
	});
});

describe('country', () => {
	it('uppercases the country code', () => {
		expect(country(reqWith({ 'CF-IPCountry': 'us' }))).toBe('US');
	});

	it('maps Tor (T1) and absent country to null', () => {
		expect(country(reqWith({ 'CF-IPCountry': 'T1' }))).toBeNull();
		expect(country(reqWith({}))).toBeNull();
	});
});

describe('clientIp', () => {
	it('returns the CF-Connecting-IP header or empty string', () => {
		expect(clientIp(reqWith({ 'CF-Connecting-IP': '203.0.113.7' }))).toBe('203.0.113.7');
		expect(clientIp(reqWith({}))).toBe('');
	});
});
