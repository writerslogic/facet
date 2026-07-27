// Request metadata: device class from UA, country normalization, client IP header, plus the segmentation
// derivations (UA-CH browser/OS/form-factor, primary language, connection tier, on-device coarse values).

import { describe, expect, it } from 'vitest';
import {
	brandFromSecChUa,
	browserFamily,
	clientIp,
	connectionTier,
	country,
	device,
	dprClass,
	formFactor,
	orientation,
	osFamily,
	primaryLanguage,
	screenTier,
} from '../src/lib/request-meta.js';

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

describe('brandFromSecChUa', () => {
	it('picks the specific brand over Chromium and the GREASE brand', () => {
		expect(
			brandFromSecChUa('"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"'),
		).toBe('Google Chrome');
	});
	it('falls back to Chromium when no specific brand is present', () => {
		expect(brandFromSecChUa('"Chromium";v="128", "Not;A=Brand";v="24"')).toBe('Chromium');
	});
	it('returns null for a missing header', () => {
		expect(brandFromSecChUa(null)).toBeNull();
	});
});

describe('browserFamily', () => {
	it('prefers the client-hint brand', () => {
		expect(browserFamily('"Microsoft Edge";v="128", "Chromium";v="128"', '')).toBe('Edge');
		expect(browserFamily('"Google Chrome";v="128"', '')).toBe('Chrome');
	});
	it('falls back to the UA string (families only, never a version)', () => {
		expect(browserFamily(null, 'Mozilla/5.0 Firefox/130.0')).toBe('Firefox');
		expect(
			browserFamily(
				null,
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605 Version/17 Safari/605',
			),
		).toBe('Safari');
	});
});

describe('osFamily', () => {
	it('uses the platform hint, normalizing macOS / Chrome OS', () => {
		expect(osFamily('"macOS"', '')).toBe('macOS');
		expect(osFamily('"Windows"', '')).toBe('Windows');
	});
	it('falls back to the UA string', () => {
		expect(osFamily(null, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
		expect(osFamily(null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(
			'iOS',
		);
	});
});

describe('formFactor', () => {
	it('separates tablets even though the mobile hint lumps them with desktop', () => {
		expect(formFactor('?0', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
	});
	it('reads the mobile hint for phones and desktops', () => {
		expect(formFactor('?1', 'Mozilla/5.0 (Linux; Android 14)')).toBe('mobile');
		expect(formFactor('?0', 'Mozilla/5.0 (Windows NT 10.0)')).toBe('desktop');
	});
});

describe('primaryLanguage', () => {
	it('keeps only the primary subtag, dropping region / quality / secondaries', () => {
		expect(primaryLanguage('en-US,en;q=0.9,de;q=0.8')).toBe('en');
		expect(primaryLanguage('fr-CA')).toBe('fr');
	});
	it('returns null for wildcard or empty', () => {
		expect(primaryLanguage('*')).toBeNull();
		expect(primaryLanguage(null)).toBeNull();
	});
});

describe('connectionTier', () => {
	it('buckets the edge RTT and rejects missing measurements', () => {
		expect(connectionTier(40)).toBe('fast');
		expect(connectionTier(180)).toBe('moderate');
		expect(connectionTier(500)).toBe('slow');
		expect(connectionTier(undefined)).toBeNull();
		expect(connectionTier(0)).toBeNull();
	});
});

describe('on-device coarse values', () => {
	it('allowlists the tracker-supplied buckets and rejects anything else', () => {
		expect(screenTier('laptop')).toBe('laptop');
		expect(screenTier('1493x817')).toBeNull();
		expect(orientation('portrait')).toBe('portrait');
		expect(orientation('sideways')).toBeNull();
		expect(dprClass('2x')).toBe('2x');
		expect(dprClass('1.5')).toBeNull();
	});
});
