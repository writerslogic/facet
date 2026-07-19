// Signed export (P2.4): when FACET_SIGNING_JWK is configured, /api/stats/export offers both a
// detached JWS and an RFC 9421 signature over the exact response bytes, and `?sign=1` returns a
// self-contained, offline-verifiable envelope. /.well-known/jwks.json publishes the verification key.
// With no key configured, nothing is signed (the deployment behaves exactly as before).

import { env } from 'cloudflare:test';
import {
	generateSigningJwk,
	verifyDetachedJws,
	verifyResponse,
	verifySignedExport,
} from '@facet/trust';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { issueKey } from '../src/lib/apikeys.js';

const SITE = '88888888-8888-4888-8888-888888888888';
const T0 = Date.UTC(2026, 3, 1, 0, 0, 0, 0);
const END = T0 + 3 * 3_600_000;

let apiKey: string;
let privateJwk: string;
let publicJwk: Awaited<ReturnType<typeof generateSigningJwk>>['publicJwk'];

function mk(i: number): NewEvent {
	return {
		siteId: SITE,
		hostname: 'x.example.com',
		path: '/',
		referrer: '',
		name: null,
		props: null,
		visitorHash: `v${i}`,
		country: 'US',
		device: 'desktop',
		createdAt: T0 + i * 1000,
	};
}

/** Request the export, optionally with a signing key injected into the env. */
function get(qs: string, signing: boolean) {
	const useEnv = signing ? { ...env, FACET_SIGNING_JWK: privateJwk } : env;
	return createApp().request(
		`https://facet.example/api/stats/export?${qs}`,
		{ headers: { Authorization: `Bearer ${apiKey}` } },
		useEnv,
	);
}

beforeEach(async () => {
	apiKey = (await issueKey(env, SITE, null, Date.now())).key;
	const gen = await generateSigningJwk('EdDSA');
	privateJwk = JSON.stringify(gen.privateJwk);
	publicJwk = gen.publicJwk;
	await insertEvent(env, mk(0));
	await insertEvent(env, mk(1));
});

describe('export signing', () => {
	it('attaches a verifiable detached JWS and RFC 9421 signature to a JSON export', async () => {
		const res = await get(`site_id=${SITE}&start=${T0}&end=${END}&format=json`, true);
		expect(res.status).toBe(200);
		const bodyText = await res.text();
		const body = new TextEncoder().encode(bodyText);

		// RFC 9421 headers present and verifying over the exact response bytes.
		const contentType = res.headers.get('content-type') as string;
		const ok = await verifyResponse({
			body,
			contentType,
			contentDigest: res.headers.get('content-digest') as string,
			signatureInput: res.headers.get('signature-input') as string,
			signature: res.headers.get('signature') as string,
			publicJwk,
		});
		expect(ok).toBe(true);

		// Detached JWS over the same bytes verifies too.
		const detached = res.headers.get('facet-signature-jws') as string;
		await expect(verifyDetachedJws(detached, body, publicJwk)).resolves.toBeDefined();

		// The advertised key URL points at this deployment's JWKS.
		expect(res.headers.get('facet-signing-key')).toBe(
			'https://facet.example/.well-known/jwks.json',
		);
	});

	it('RFC 9421 verification fails if the body is altered', async () => {
		const res = await get(`site_id=${SITE}&start=${T0}&end=${END}&format=json`, true);
		const contentType = res.headers.get('content-type') as string;
		const ok = await verifyResponse({
			body: new TextEncoder().encode('{"columns":[],"rows":[]}'),
			contentType,
			contentDigest: res.headers.get('content-digest') as string,
			signatureInput: res.headers.get('signature-input') as string,
			signature: res.headers.get('signature') as string,
			publicJwk,
		});
		expect(ok).toBe(false);
	});

	it('?sign=1 returns a self-contained envelope that verifies offline', async () => {
		const res = await get(`site_id=${SITE}&start=${T0}&end=${END}&format=json&sign=1`, true);
		expect(res.status).toBe(200);
		const envelope = await res.json();
		const v = await verifySignedExport(envelope as never);
		expect(v.valid).toBe(true);
		expect(v.jwksUrl).toBe('https://facet.example/.well-known/jwks.json');
	});

	it('a tampered envelope payload fails verification', async () => {
		const res = await get(`site_id=${SITE}&start=${T0}&end=${END}&format=json&sign=1`, true);
		const envelope = (await res.json()) as { payload: { rows: unknown[] } };
		envelope.payload.rows = [['tampered', 1, 1, 1]];
		const v = await verifySignedExport(envelope as never);
		expect(v.valid).toBe(false);
	});

	it('does not sign when no key is configured, and 501s on ?sign=1', async () => {
		const plain = await get(`site_id=${SITE}&start=${T0}&end=${END}&format=json`, false);
		expect(plain.status).toBe(200);
		expect(plain.headers.get('signature')).toBeNull();
		expect(plain.headers.get('facet-signature-jws')).toBeNull();

		const signed = await get(
			`site_id=${SITE}&start=${T0}&end=${END}&format=json&sign=1`,
			false,
		);
		expect(signed.status).toBe(501);
	});
});

describe('GET /.well-known/jwks.json', () => {
	it('publishes the public key when signing is configured', async () => {
		const res = await createApp().request(
			'https://facet.example/.well-known/jwks.json',
			{},
			{ ...env, FACET_SIGNING_JWK: privateJwk },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('jwk-set');
		const jwks = (await res.json()) as { keys: { kid: string }[] };
		expect(jwks.keys).toHaveLength(1);
		expect(jwks.keys[0]?.kid).toBe(publicJwk.kid);
	});

	it('is an empty key set when signing is unconfigured', async () => {
		const res = await createApp().request(
			'https://facet.example/.well-known/jwks.json',
			{},
			env,
		);
		const jwks = (await res.json()) as { keys: unknown[] };
		expect(jwks.keys).toHaveLength(0);
	});
});
