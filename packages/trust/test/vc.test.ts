// VC Data Integrity (eddsa-jcs-2022) + Multikey + base58 + did:web / DID Configuration. Runs in
// workerd. Covers: base58 round-trip, JWK<->publicKeyMultibase, credential issue/verify, tamper and
// wrong-key failure, did:web URL resolution, and a full domain-linkage verification against a DID doc.

import { describe, expect, it } from 'vitest';
import { base58decode, base58encode } from '../src/base58.js';
import { canonicalDigest } from '../src/canonicalize.js';
import {
	buildDidConfiguration,
	buildDidDocument,
	didWebFromHost,
	didWebToUrl,
	issueDomainLinkageCredential,
	verifyDidConfiguration,
} from '../src/did-web.js';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';
import { jwkToPublicKeyMultibase, publicKeyMultibaseToJwk } from '../src/multikey.js';
import {
	VC_V2_CONTEXT,
	type VerifiableCredential,
	issueCredential,
	verifyCredential,
} from '../src/vc.js';

async function edKey() {
	const { privateJwk, publicJwk } = await generateSigningJwk('EdDSA');
	return { key: await loadSigningKey(JSON.stringify(privateJwk)), publicJwk };
}

describe('base58', () => {
	it('round-trips arbitrary bytes and preserves leading zeros', () => {
		for (const bytes of [
			new Uint8Array([0, 0, 1, 2, 3]),
			new Uint8Array([255, 254, 0, 42]),
			new Uint8Array(32).fill(7),
		]) {
			expect(Array.from(base58decode(base58encode(bytes)))).toEqual(Array.from(bytes));
		}
	});
});

describe('multikey', () => {
	it('encodes an Ed25519 JWK to publicKeyMultibase (z6Mk…) and back', async () => {
		const { publicJwk } = await generateSigningJwk('EdDSA');
		const mb = jwkToPublicKeyMultibase(publicJwk);
		expect(mb.startsWith('z6Mk')).toBe(true);
		const back = publicKeyMultibaseToJwk(mb);
		expect(back.x).toBe(publicJwk.x);
	});
});

describe('eddsa-jcs-2022 credential', () => {
	const base: VerifiableCredential = {
		'@context': [VC_V2_CONTEXT],
		type: ['VerifiableCredential', 'PrivacyAttestationCredential'],
		issuer: 'did:web:facet.example',
		validFrom: '2026-07-01T00:00:00.000Z',
		credentialSubject: { id: 'did:web:facet.example', retentionDays: 90 },
	};

	it('issues and verifies with the embedded key (JWK or multibase)', async () => {
		const { key, publicJwk } = await edKey();
		const vc = await issueCredential(base, key, {
			verificationMethod: `did:web:facet.example#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		expect(vc.proof?.cryptosuite).toBe('eddsa-jcs-2022');
		expect(vc.proof?.proofValue.startsWith('z')).toBe(true);

		expect((await verifyCredential(vc, { publicJwk })).valid).toBe(true);
		const mb = jwkToPublicKeyMultibase(publicJwk);
		expect((await verifyCredential(vc, { publicKeyMultibase: mb })).valid).toBe(true);
	});

	it('fails when a claim is tampered', async () => {
		const { key, publicJwk } = await edKey();
		const vc = await issueCredential(base, key, {
			verificationMethod: `did:web:facet.example#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		vc.credentialSubject.retentionDays = 3650;
		const res = await verifyCredential(vc, { publicJwk });
		expect(res.valid).toBe(false);
	});

	it('fails under a different key', async () => {
		const { key } = await edKey();
		const other = await generateSigningJwk('EdDSA');
		const vc = await issueCredential(base, key, {
			verificationMethod: `did:web:facet.example#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		expect((await verifyCredential(vc, { publicJwk: other.publicJwk })).valid).toBe(false);
	});

	it('refuses to issue with a non-Ed25519 key', async () => {
		const { privateJwk } = await generateSigningJwk('ES256');
		const es = await loadSigningKey(JSON.stringify(privateJwk));
		await expect(
			issueCredential(base, es, {
				verificationMethod: 'x#y',
				created: 'now',
			}),
		).rejects.toThrow();
	});

	// Reconstruct the W3C vc-di-eddsa hashData — SHA-256(JCS(proofConfig)) || SHA-256(JCS(unsecured)) —
	// from the spec's own steps here (not from vc.ts), sign it with Web Crypto directly, and multibase-
	// encode. Ed25519 determinism means a spec-conformant issuer must emit exactly this proofValue: this
	// pins the proof-config field set, the hash concatenation order, and the z-base58btc encoding.
	it('proofValue matches a from-scratch eddsa-jcs-2022 construction', async () => {
		const { privateJwk, publicJwk } = await generateSigningJwk('EdDSA');
		const key = await loadSigningKey(JSON.stringify(privateJwk));
		const created = '2026-07-01T00:00:00.000Z';
		const verificationMethod = `did:web:facet.example#${key.kid}`;

		// Independent proof configuration (proof options, no proofValue) per the cryptosuite.
		const proofConfigObj = {
			'@context': base['@context'],
			type: 'DataIntegrityProof',
			cryptosuite: 'eddsa-jcs-2022',
			created,
			verificationMethod,
			proofPurpose: 'assertionMethod',
		};
		// hashData = proofConfigHash || documentHash (the unsecured credential has no proof to strip).
		const hashData = new Uint8Array(64);
		hashData.set(await canonicalDigest(proofConfigObj), 0);
		hashData.set(await canonicalDigest(base), 32);

		const priv = await crypto.subtle.importKey(
			'jwk',
			privateJwk as unknown as JsonWebKey,
			{ name: 'Ed25519' },
			false,
			['sign'],
		);
		const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, hashData));
		const expectedProofValue = `z${base58encode(sig)}`;

		const vc = await issueCredential(base, key, {
			verificationMethod,
			created,
		});
		expect(vc.proof?.proofValue).toBe(expectedProofValue);
		expect((await verifyCredential(vc, { publicJwk })).valid).toBe(true);
	});

	it('enforces validFrom/validUntil only when a clock is supplied', async () => {
		const { key, publicJwk } = await edKey();
		// validFrom 2026-07-01, validUntil 2026-08-01 — both are inside the signed document.
		const vc = await issueCredential({ ...base, validUntil: '2026-08-01T00:00:00.000Z' }, key, {
			verificationMethod: `did:web:facet.example#${key.kid}`,
			created: '2026-07-01T00:00:00.000Z',
		});
		const within = Date.parse('2026-07-15T00:00:00.000Z');
		const before = Date.parse('2026-06-01T00:00:00.000Z');
		const after = Date.parse('2026-09-01T00:00:00.000Z');

		// No clock → temporal validity is the caller's problem; signature alone decides.
		expect((await verifyCredential(vc, { publicJwk })).valid).toBe(true);
		// With a clock, the window is enforced against the authentic (signed) bounds.
		expect((await verifyCredential(vc, { publicJwk, now: within })).valid).toBe(true);
		const early = await verifyCredential(vc, { publicJwk, now: before });
		expect(early.valid).toBe(false);
		expect(early.reason).toBe('credential not yet valid');
		const expired = await verifyCredential(vc, { publicJwk, now: after });
		expect(expired.valid).toBe(false);
		expect(expired.reason).toBe('credential expired');
	});
});

describe('did:web', () => {
	it('builds the DID and resolves its document URL', () => {
		expect(didWebFromHost('facet.example')).toBe('did:web:facet.example');
		expect(didWebToUrl('did:web:facet.example')).toBe(
			'https://facet.example/.well-known/did.json',
		);
		expect(didWebToUrl('did:web:facet.example:tenant:a')).toBe(
			'https://facet.example/tenant/a/did.json',
		);
		// A port (encoded %3A) is allowed; path-traversal / host-confusion via percent-encoding is not.
		expect(didWebToUrl('did:web:facet.example%3A8443')).toBe(
			'https://facet.example:8443/.well-known/did.json',
		);
		expect(() => didWebToUrl('did:web:facet.example:%2e%2e')).toThrow();
		expect(() => didWebToUrl('did:web:evil.example%2fpath')).toThrow();
	});

	// The host is the ONE request-derived value the deployment copies verbatim into every signed
	// artifact it issues (a credential's `issuer`, its `verificationMethod`, a consent statement's
	// `iss`), so the two spec constraints on it are enforced at the mint, not just on resolution.
	it('refuses a host the did:web spec cannot express', () => {
		// did:web: "it MUST NOT include IP addresses." The ABNF would accept these digits and dots.
		expect(() => didWebFromHost('192.0.2.10')).toThrow(/must not include IP addresses/);
		expect(() => didWebFromHost('192.0.2.10:8443')).toThrow(/must not include IP addresses/);
		// A URL parser reads a bare number and an 0x literal as IPv4 too, so the rule is "the last
		// label is a number", not "it looks like a dotted quad".
		expect(() => didWebFromHost('12345')).toThrow(/must not include IP addresses/);
		expect(() => didWebFromHost('0x7f000001')).toThrow(/must not include IP addresses/);
		// ...and the rule is about the LAST label only: these are ordinary names, not addresses.
		expect(didWebFromHost('a12345')).toBe('did:web:a12345');
		expect(didWebFromHost('192.0.2.10.example')).toBe('did:web:192.0.2.10.example');

		// DID Core §3.1: `idchar = ALPHA / DIGIT / "." / "-" / "_" / pct-encoded`. An IPv6 literal's
		// brackets, and every other character a URL host may legally carry, are outside it.
		expect(() => didWebFromHost('[2001:db8::1]')).toThrow(/idchar/);
		expect(() => didWebFromHost('facet.example/evil')).toThrow(/idchar/);
		expect(() => didWebFromHost('a$b.example')).toThrow(/idchar/);
		expect(() => didWebFromHost('')).toThrow(/idchar/);
		// `_` is legal per the ABNF and still refused: did:web additionally requires the identifier to
		// match the TLS certificate name, and no public CA issues for an underscore label.
		expect(() => didWebFromHost('my_app.example')).toThrow(/idchar/);

		// A legitimate name, with and without a port, is untouched.
		expect(didWebFromHost('facet.example')).toBe('did:web:facet.example');
		expect(didWebFromHost('facet.example:8443')).toBe('did:web:facet.example%3A8443');
	});

	it('refuses to resolve a DID naming an IP address', () => {
		// Same predicate on the way back in: without it this hands an attacker-chosen literal address
		// to `resolveDidWeb`'s fetch.
		expect(() => didWebToUrl('did:web:192.0.2.10')).toThrow(/must not include IP addresses/);
		expect(() => didWebToUrl('did:web:192.0.2.10%3A8443')).toThrow(/must not include IP/);
		expect(() => didWebToUrl('did:web:12345:tenant:a')).toThrow(
			/must not include IP addresses/,
		);
		expect(didWebToUrl('did:web:192.0.2.10.example')).toBe(
			'https://192.0.2.10.example/.well-known/did.json',
		);
	});

	it('verifies a full domain linkage against the DID document', async () => {
		const { key, publicJwk } = await edKey();
		const did = didWebFromHost('facet.example');
		const origin = 'https://facet.example';
		const didDoc = buildDidDocument(did, key.kid, publicJwk);
		const cred = await issueDomainLinkageCredential({
			did,
			origin,
			key,
			created: '2026-07-01T00:00:00.000Z',
		});
		const config = buildDidConfiguration([cred]);

		const ok = await verifyDidConfiguration(config, didDoc, origin);
		expect(ok.valid).toBe(true);
		expect(ok.origin).toBe(origin);

		// Wrong origin must fail.
		const bad = await verifyDidConfiguration(config, didDoc, 'https://evil.example');
		expect(bad.valid).toBe(false);
	});

	it('rejects a linkage credential whose issuer is not the DID', async () => {
		const { key, publicJwk } = await edKey();
		const did = didWebFromHost('facet.example');
		const origin = 'https://facet.example';
		const didDoc = buildDidDocument(did, key.kid, publicJwk);
		const cred = await issueDomainLinkageCredential({
			did,
			origin,
			key,
			created: '2026-07-01T00:00:00.000Z',
		});
		// A credential that still names the DID as its subject but claims a different issuer must be
		// rejected at the issuer gate — a self-signed credential can't forge a domain linkage.
		const forged = { ...cred, issuer: 'did:web:evil.example' };
		const config = buildDidConfiguration([forged]);
		const res = await verifyDidConfiguration(config, didDoc, origin);
		expect(res.valid).toBe(false);
		expect(res.reason).toBe('credential issuer does not match DID');
	});
});
