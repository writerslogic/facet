// Cross-origin CORS for the two endpoints the browser tracker calls.
//
// Regression test for a live outage: facet.writerslogic.com collected nothing at all from
// writersproof.com. Two independent causes, both invisible server-side because every response
// was a 200 — the browser discarded them after the fact.
//
//   /api/collect          answered `Access-Control-Allow-Origin: *`, but navigator.sendBeacon()
//                         always issues its request in credentials mode, and a credentialed
//                         request against a wildcard is rejected by the browser.
//   /api/experiments/active carried no CORS headers whatsoever, so the response was blocked.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();
const ORIGIN = 'https://writersproof.com';

describe('cross-origin CORS for the browser tracker', () => {
	it('reflects the caller origin on the beacon rather than sending a wildcard', async () => {
		const res = await app.request(
			'/api/collect',
			{ method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } },
			env,
		);
		const allowOrigin = res.headers.get('access-control-allow-origin');
		// A wildcard here is precisely what broke sendBeacon.
		expect(allowOrigin).not.toBe('*');
		expect(allowOrigin).toBe(ORIGIN);
		expect(res.headers.get('access-control-allow-credentials')).toBe('true');
	});

	it('allows a credentialed cross-origin beacon POST', async () => {
		const res = await app.request(
			'/api/collect',
			{
				method: 'POST',
				headers: { Origin: ORIGIN, 'content-type': 'application/json' },
				body: JSON.stringify({}),
			},
			env,
		);
		// The payload may well be rejected on its merits; what matters is that the response
		// carries headers the browser will accept for a credentialed request.
		expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
	});

	it('sends CORS headers on the experiment config the tracker reads', async () => {
		const res = await app.request(
			'/api/experiments/active?site_id=00000000-0000-0000-0000-000000000000',
			{ headers: { Origin: ORIGIN } },
			env,
		);
		// Was absent entirely, so a 200 was still blocked by the browser.
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});

	it('answers the experiment preflight', async () => {
		const res = await app.request(
			'/api/experiments/active',
			{ method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } },
			env,
		);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});
});
