// W3C Data Privacy Vocabulary (DPV v2.1, namespace https://w3id.org/dpv#) expression of Facet's
// processing. Embedded in the PrivacyAttestationCredential and served as a machine-readable manifest
// at /.well-known/facet-privacy.json.
//
// These claims are SIGNED and follow the deployment's bindings. A deployment with `CRM_DB` can store
// explicitly materialized, pseudonymous contact records; it never gains permission to claim that raw
// email, telephone, analytics identity stitching, or an operator-access audit log exists.

import type { Env } from '../env.js';

/** DPV namespace + prefix, referenced as the JSON-LD context of the claims. */
export const DPV_CONTEXT = { dpv: 'https://w3id.org/dpv#' } as const;

/** DPV + the Personal Data Categories extension, used only when there is stored personal data to name. */
export const DPV_PD_CONTEXT = {
	dpv: 'https://w3id.org/dpv#',
	pd: 'https://w3id.org/dpv/pd#',
} as const;

type DpvClaims = {
	'@context': typeof DPV_CONTEXT | typeof DPV_PD_CONTEXT;
	'dpv:hasProcessing': string[];
	'dpv:hasPurpose': string | string[];
	'dpv:hasLegalBasis': string | string[];
	'dpv:hasTechnicalOrganisationalMeasure': string[];
	'dpv:hasRole'?: string;
	'dpv:hasDataSubject'?: string;
	'dpv:hasPersonalData'?: string[];
};

/**
 * Facet's DPV claims: processing operations, purpose, legal basis, and technical measures.
 *
 * Analytics-only (no `CRM_DB`): Collect (events) → Derive (windowed visitor hash from IP+UA,
 * transient) → Aggregate (rollups) → Analyse (reports). The raw IP is never stored, so
 * Pseudonymisation genuinely covers the whole dataset and LegitimateInterest is the only basis —
 * as long as the deployment also cannot mint a consent record, which is the second axis below and
 * is keyed on `FACET_SIGNING_JWK` rather than on the CRM.
 *
 * With the CRM bound, Store/Erase and CRM purpose are added. Facet remains the processor, every
 * contact carries its operator-declared legal basis, and the only structural identifier is a keyed,
 * site-scoped digest. No analytics bridge is represented by this schema.
 */
export function privacyDpvClaims(env: Env): Record<string, unknown> {
	const claims = baseClaims(env);
	// Tier 1/2 elevation is refused (501) without a deployment signing key, so THIS binding, not
	// CRM_DB, decides whether the analytics database can ever hold a consent record: a row storing
	// the raw site-supplied uid at rest (`consent_records.external_user_id`), erased by revocation
	// and by the retention cron, and the sole authorization for a visitor above Tier 0.
	// YAGNI: `AI` deliberately adds no claim - the NL prompt carries operator-authored question text,
	// never visitor data, to Workers AI inside the account already running this Worker and its D1.
	return env.FACET_SIGNING_JWK ? withConsentedIdentity(claims) : claims;
}

/**
 * A deployment that can mint consent records stores a directly-identifying value the analytics
 * claims otherwise deny: `dpv:Store`/`dpv:Erase` for the record's lifecycle, `dpv:Consent` because
 * elevation rests on nothing else, and `pd:UID` because the uid is held raw rather than hashed.
 */
function withConsentedIdentity(claims: DpvClaims): DpvClaims {
	const basis = claims['dpv:hasLegalBasis'];
	return {
		...claims,
		'@context': DPV_PD_CONTEXT,
		'dpv:hasProcessing': union(claims['dpv:hasProcessing'], ['dpv:Store', 'dpv:Erase']),
		'dpv:hasLegalBasis': union(Array.isArray(basis) ? basis : [basis], ['dpv:Consent']),
		'dpv:hasPersonalData': union(claims['dpv:hasPersonalData'] ?? [], ['pd:UID']),
	};
}

function union(current: string[], additions: string[]): string[] {
	const out = [...current];
	for (const term of additions) {
		if (!out.includes(term)) out.push(term);
	}
	return out;
}

function baseClaims(env: Env): DpvClaims {
	if (!env.CRM_DB) {
		return {
			'@context': DPV_CONTEXT,
			'dpv:hasProcessing': ['dpv:Collect', 'dpv:Derive', 'dpv:Aggregate', 'dpv:Analyse'],
			'dpv:hasPurpose': 'dpv:ServiceOptimisation',
			'dpv:hasLegalBasis': 'dpv:LegitimateInterest',
			'dpv:hasTechnicalOrganisationalMeasure': ['dpv:Pseudonymisation'],
		};
	}
	return {
		'@context': DPV_PD_CONTEXT,
		'dpv:hasProcessing': [
			'dpv:Collect',
			'dpv:Derive',
			'dpv:Aggregate',
			'dpv:Analyse',
			'dpv:Store',
			'dpv:Erase',
		],
		'dpv:hasPurpose': ['dpv:ServiceOptimisation', 'dpv:CustomerRelationshipManagement'],
		// The controller chooses one of these per materialized contact. Facet does not infer a basis.
		'dpv:hasLegalBasis': [
			'dpv:LegitimateInterest',
			'dpv:Consent',
			'dpv:Contract',
			'dpv:LegalObligation',
			'dpv:VitalInterest',
			'dpv:PublicInterest',
		],
		'dpv:hasTechnicalOrganisationalMeasure': [
			'dpv:Pseudonymisation',
			'dpv:AccessControlMethod',
		],
		'dpv:hasRole': 'dpv:DataProcessor',
		'dpv:hasDataSubject': 'dpv:Customer',
		// `alias` may be a display name; the operator id itself exists only as a keyed digest.
		'dpv:hasPersonalData': ['pd:Name', 'pd:UID'],
	};
}
