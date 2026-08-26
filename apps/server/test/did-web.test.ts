// P3.5: did:web + DIF Well-Known DID Configuration served from the Worker. did.json exposes the
// deployment's Ed25519 key as a Multikey verification method; did-configuration.json carries a signed
// Domain Linkage Credential binding the origin to the DID. Both require an Ed25519 signing key and
// 404 when unconfigured; the linkage verifies against the served DID document.

import { env } from 'cloudflare:workers';
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

function req(path: string, signing: boolean, host = 'facet.example') {
	const useEnv = signing ? { ...env, FACET_SIGNING_JWK: privateJwk } : env;
	return createApp().request(`https://${host}${path}`, {}, useEnv);
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

	// The deployment DID is built from the REQUEST host, and every artefact it goes into is signed.
	// A host the did:web spec cannot express has no DID document, so none is invented for it.
	it('404s did_unavailable when the host cannot be a did:web', async () => {
		for (const host of ['192.0.2.10', '192.0.2.10:8443', '[2001:db8::1]']) {
			const res = await req('/.well-known/did.json', true, host);
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ error: 'did_unavailable' });
		}
		// The refusal is the IP, not the port or the digits: a name is still served.
		const ok = await req('/.well-known/did.json', true, 'facet.example:8443');
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as DidDocument).id).toBe('did:web:facet.example%3A8443');
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

	// The linkage credential is SIGNED and names the DID as both issuer and subject, so an
	// unresolvable DID here would be a signature on a claim about an identity that cannot exist.
	it('404s did_unavailable when the host cannot be a did:web', async () => {
		const res = await req('/.well-known/did-configuration.json', true, '192.0.2.10');
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'did_unavailable' });
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
		// The test env binds CRM_DB, so the manifest carries the CRM claims and the pd: namespace
		// those terms need in order to resolve. Both shapes are pinned in dpv.test.ts; what this
		// asserts is that the served document tracks the binding rather than a constant.
		expect(manifest.dpv['dpv:hasPurpose']).toEqual([
			'dpv:ServiceOptimisation',
			'dpv:CustomerRelationshipManagement',
		]);
		expect(manifest.dpv['@context']).toEqual({
			dpv: 'https://w3id.org/dpv#',
			pd: 'https://w3id.org/dpv/pd#',
		});
	});
});
