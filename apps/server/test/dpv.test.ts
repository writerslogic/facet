// The DPV claims track the bindings, because they are SIGNED. `privacyDpvClaims` is embedded in the
// PrivacyAttestationCredential and in the SCITT Signed Statement, so a claim that does not match what
// the deployment actually does is not a stale comment — it is a false statement under the deployment
// key. These tests pin both shapes and, more importantly, pin the differences between them.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { privacyDpvClaims } from '../src/lib/dpv.js';

/** The analytics-only deployment: no CRM database was ever created. */
function analyticsOnly(): Env {
	const { CRM_DB: Omitted, ...rest } = env;
	return rest as unknown as Env;
}

describe('analytics-only deployment', () => {
	const claims = privacyDpvClaims(analyticsOnly());

	it('claims exactly what it did before the CRM existed', () => {
		expect(claims['dpv:hasProcessing']).toEqual([
			'dpv:Collect',
			'dpv:Derive',
			'dpv:Aggregate',
			'dpv:Analyse',
		]);
		expect(claims['dpv:hasPurpose']).toBe('dpv:ServiceOptimisation');
		expect(claims['dpv:hasLegalBasis']).toBe('dpv:LegitimateInterest');
		expect(claims['dpv:hasTechnicalOrganisationalMeasure']).toEqual(['dpv:Pseudonymisation']);
	});

	it('names no stored personal data and no data subject, because it holds neither', () => {
		expect(claims['dpv:hasPersonalData']).toBeUndefined();
		expect(claims['dpv:hasDataSubject']).toBeUndefined();
		expect(claims['dpv:hasProcessing']).not.toContain('dpv:Store');
	});
});

describe('CRM-enabled deployment', () => {
	const claims = privacyDpvClaims(env as unknown as Env);

	it('adds storage and erasure to the processing it declares', () => {
		// Contacts are retained as business records and really deleted on request; both are
		// processing operations the analytics-only deployment genuinely does not perform.
		expect(claims['dpv:hasProcessing']).toContain('dpv:Store');
		expect(claims['dpv:hasProcessing']).toContain('dpv:Erase');
	});

	it('adds consent as a legal basis rather than resting on legitimate interest alone', () => {
		// The contact→analytics link is authorized ONLY by an active signed consent record, so
		// consent is a basis this deployment actually relies on.
		expect(claims['dpv:hasLegalBasis']).toEqual(['dpv:LegitimateInterest', 'dpv:Consent']);
	});

	it('stops letting pseudonymisation imply coverage it does not have', () => {
		// Pseudonymisation still describes the analytics half and stays. What must NOT happen is it
		// remaining the ONLY declared measure, which would read as "everything here is pseudonymised"
		// while the CRM holds names and email addresses in the clear.
		const measures = claims['dpv:hasTechnicalOrganisationalMeasure'] as string[];
		expect(measures).toContain('dpv:Pseudonymisation');
		expect(measures).toContain('dpv:AccessControlMethod');
		expect(measures).not.toEqual(['dpv:Pseudonymisation']);
	});

	it('names the personal data it holds and the subject it holds it about', () => {
		expect(claims['dpv:hasPersonalData']).toEqual([
			'pd:Name',
			'pd:EmailAddress',
			'pd:TelephoneNumber',
		]);
		expect(claims['dpv:hasDataSubject']).toBe('dpv:Customer');
		// Naming pd: terms requires the extension's namespace to be in the context, or the document
		// is not resolvable JSON-LD and the extra honesty is unreadable.
		expect(claims['@context']).toMatchObject({ pd: 'https://w3id.org/dpv/pd#' });
	});
});

describe('the served manifest follows the binding', () => {
	it('serves CRM claims at /.well-known/facet-privacy.json when CRM_DB is bound', async () => {
		const res = await createApp().request('/.well-known/facet-privacy.json', {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { dpv: Record<string, unknown> };
		expect(body.dpv['dpv:hasProcessing']).toContain('dpv:Store');
	});

	it('serves the analytics-only claims when it is not', async () => {
		const res = await createApp().request(
			'/.well-known/facet-privacy.json',
			{},
			analyticsOnly() as unknown as typeof env,
		);
		const body = (await res.json()) as { dpv: Record<string, unknown> };
		expect(body.dpv['dpv:hasProcessing']).not.toContain('dpv:Store');
		expect(body.dpv['dpv:hasLegalBasis']).toBe('dpv:LegitimateInterest');
	});
});
