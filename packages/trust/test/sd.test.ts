// Selective disclosure (SD-JWT-style): a revealed disclosure must match a signed _sd digest, and the
// verifier must enforce one authoritative value per claim name. These lock the uniqueness guards that
// stop a last-wins claim substitution (duplicate digest, duplicate/colliding disclosed name).

import { describe, expect, it } from 'vitest';
import { generateSigningJwk, loadSigningKey } from '../src/keys.js';
import {
	deriveDisclosure,
	issueSelectiveCredential,
	verifySelectiveCredential,
} from '../src/sd.js';
import { VC_V2_CONTEXT, type VerifiableCredential } from '../src/vc.js';

async function edKey() {
	const { privateJwk, publicJwk } = await generateSigningJwk('EdDSA');
	return { key: await loadSigningKey(JSON.stringify(privateJwk)), publicJwk };
}

const base: VerifiableCredential = {
	'@context': [VC_V2_CONTEXT],
	type: ['VerifiableCredential', 'DatasetAttestationCredential'],
	issuer: 'did:web:facet.example',
	credentialSubject: { id: 'did:web:facet.example' },
};

const opts = {
	verificationMethod: 'did:web:facet.example#k',
	created: '2026-07-01T00:00:00.000Z',
};

describe('selective disclosure', () => {
	it('reveals a disclosed claim whose digest is in the signed _sd set', async () => {
		const { key, publicJwk } = await edKey();
		const issued = await issueSelectiveCredential(
			base,
			{ region: 'eu' },
			{ rps: 1200 },
			key,
			opts,
		);
		const res = await verifySelectiveCredential(issued, { publicJwk });
		expect(res.valid).toBe(true);
		expect(res.revealed).toEqual({ rps: 1200 });
	});

	it('rejects the same disclosure presented twice (no last-wins)', async () => {
		const { key, publicJwk } = await edKey();
		const issued = await issueSelectiveCredential(base, {}, { rps: 1200 }, key, opts);
		const doubled = {
			...issued,
			disclosures: [...issued.disclosures, ...issued.disclosures],
		};
		const res = await verifySelectiveCredential(doubled, { publicJwk });
		expect(res.valid).toBe(false);
		expect(res.reason).toBe('duplicate disclosure digest');
	});

	it('rejects a fabricated disclosure whose digest is not in _sd', async () => {
		const { key, publicJwk } = await edKey();
		const issued = await issueSelectiveCredential(base, {}, { rps: 1200 }, key, opts);
		const forged = {
			...issued,
			disclosures: [
				{
					salt: issued.disclosures[0]?.salt ?? 'x',
					name: 'rps',
					value: 999999,
				},
			],
		};
		const res = await verifySelectiveCredential(forged, { publicJwk });
		expect(res.valid).toBe(false);
	});

	it('refuses to issue a selective claim that collides with a mandatory or reserved name', async () => {
		const { key } = await edKey();
		await expect(
			issueSelectiveCredential(base, { region: 'eu' }, { region: 'us' }, key, opts),
		).rejects.toThrow(/collides/);
		await expect(
			issueSelectiveCredential(base, {}, { id: 'spoof' }, key, opts),
		).rejects.toThrow(/collides/);
	});

	it('deriveDisclosure reveals only the requested subset', async () => {
		const { key, publicJwk } = await edKey();
		const issued = await issueSelectiveCredential(
			base,
			{},
			{ rps: 1200, region: 'eu' },
			key,
			opts,
		);
		const presentation = deriveDisclosure(issued, ['rps']);
		const res = await verifySelectiveCredential(presentation, {
			publicJwk,
		});
		expect(res.valid).toBe(true);
		expect(res.revealed).toEqual({ rps: 1200 });
	});
});
