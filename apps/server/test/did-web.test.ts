// P3.5: did:web + DIF Well-Known DID Configuration served from the Worker. did.json exposes the
// deployment's Ed25519 key as a Multikey verification method; did-configuration.json carries a signed
// Domain Linkage Credential binding the origin to the DID. Both require an Ed25519 signing key and
// 404 when unconfigured; the linkage verifies against the served DID document.

import { env } from 'cloudflare:test';
import {
	type DidConfiguration,
	type DidDocument,
	generateSigningJwk,
	verifyDidConfiguration,
} from '@facet/trust';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

let privateJwk: string;
let publicKid: string;

beforeEach(async () => {
	const gen = await generateSigningJwk('EdDSA');
	privateJwk = JSON.stringify(gen.privateJwk);
	publicKid = gen.publicJwk.kid as string;
});

function req(path: string, signing: boolean) {
	const useEnv = signing ? { ...env, FACET_SIGNING_JWK: privateJwk } : env;
	return createApp().request(`https://facet.example${path}`, {}, useEnv);
}

describe('GET /.well-known/did.json', () => {
	it('serves a DID document with the deployment Multikey', async () => {
		const res = await req('/.well-known/did.json', true);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('did+json');
		const doc = (await res.json()) as DidDocument;
		expect(doc.id).toBe('did:web:facet.example');
		expect(doc.verificationMethod[0]?.type).toBe('Multikey');
		expect(doc.verificationMethod[0]?.id).toBe(`did:web:facet.example#${publicKid}`);
		expect(doc.verificationMethod[0]?.publicKeyMultibase.startsWith('z6Mk')).toBe(true);
		expect(doc.assertionMethod).toContain(`did:web:facet.example#${publicKid}`);
	});

	it('404s when signing is unconfigured', async () => {
		const res = await req('/.well-known/did.json', false);
		expect(res.status).toBe(404);
	});
});

describe('GET /.well-known/did-configuration.json', () => {
	it('serves a Domain Linkage Credential that verifies against the DID document', async () => {
		const didRes = await req('/.well-known/did.json', true);
		const didDoc = (await didRes.json()) as DidDocument;
		const cfgRes = await req('/.well-known/did-configuration.json', true);
		expect(cfgRes.status).toBe(200);
		const config = (await cfgRes.json()) as DidConfiguration;
		expect(config.linked_dids).toHaveLength(1);

		const result = await verifyDidConfiguration(config, didDoc, 'https://facet.example');
		expect(result.valid).toBe(true);
		expect(result.origin).toBe('https://facet.example');
	});

	it('404s when signing is unconfigured', async () => {
		const res = await req('/.well-known/did-configuration.json', false);
		expect(res.status).toBe(404);
	});
});

describe('GET /.well-known/facet-privacy.json', () => {
	it('serves an unsigned DPV privacy manifest (no key required)', async () => {
		const res = await req('/.well-known/facet-privacy.json', false);
		expect(res.status).toBe(200);
		const manifest = (await res.json()) as {
			deployment: {
				schemaHash: string;
				privacy: { storesRawIp: boolean };
			};
			dpv: Record<string, unknown>;
		};
		expect(manifest.deployment.privacy.storesRawIp).toBe(false);
		expect(manifest.deployment.schemaHash).toMatch(/^[0-9a-f]{64}$/);
		expect(manifest.dpv['dpv:hasPurpose']).toBe('dpv:ServiceOptimisation');
		expect(manifest.dpv['@context']).toEqual({
			dpv: 'https://w3id.org/dpv#',
		});
	});
});
