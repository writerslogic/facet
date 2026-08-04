// W3C Data Privacy Vocabulary (DPV v2.1, namespace https://w3id.org/dpv#) expression of Facet's
// processing. Embedded in the PrivacyAttestationCredential and served as a machine-readable manifest
// at /.well-known/facet-privacy.json.
//
// These claims are SIGNED. They are therefore derived from the deployment's actual bindings, not
// hardcoded: a deployment with the optional CRM extension bound (`CRM_DB`) stores contact details a
// person handed over directly, which is a different processing operation, a different legal basis, a
// different purpose, and a different data subject than analytics over pseudonymous hashes. Returning
// the analytics-only claims from a CRM deployment would make it cryptographically sign a false
// statement, so every caller passes `env` and the claims follow the binding.

import type { Env } from '../env.js';

/** DPV namespace + prefix, referenced as the JSON-LD context of the claims. */
export const DPV_CONTEXT = { dpv: 'https://w3id.org/dpv#' } as const;

/** DPV + the Personal Data Categories extension, used only when there is stored personal data to name. */
export const DPV_PD_CONTEXT = {
	dpv: 'https://w3id.org/dpv#',
	pd: 'https://w3id.org/dpv/pd#',
} as const;

/**
 * Facet's DPV claims: processing operations, purpose, legal basis, and technical measures.
 *
 * Analytics-only (no `CRM_DB`): Collect (events) → Derive (windowed visitor hash from IP+UA,
 * transient) → Aggregate (rollups) → Analyse (reports). The raw IP is never stored, so
 * Pseudonymisation genuinely covers the whole dataset and LegitimateInterest is the only basis.
 *
 * With the CRM bound, three things stop being true and the claims say so:
 *   • `dpv:Store` and `dpv:Erase` join the processing set — contact details are retained as a
 *     business record (deliberately NOT on the raw-event retention schedule) and erased on request.
 *   • `dpv:Consent` joins the legal basis — the contact→analytics link is authorized only by an
 *     active signed consent record, never by legitimate interest.
 *   • Pseudonymisation stops being the sole measure. It still describes the analytics half, but
 *     directly-supplied contact details are not pseudonymised; what protects them is access control
 *     (an authenticated operator session with a team role, never an API key), so that is named
 *     alongside it rather than letting one term imply coverage it does not have.
 */
export function privacyDpvClaims(env: Env): Record<string, unknown> {
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
		'dpv:hasLegalBasis': ['dpv:LegitimateInterest', 'dpv:Consent'],
		'dpv:hasTechnicalOrganisationalMeasure': [
			'dpv:Pseudonymisation',
			'dpv:AccessControlMethod',
		],
		'dpv:hasDataSubject': 'dpv:Customer',
		// The categories the contact schema has columns for. Free-text fields an operator may fill
		// with anything are deliberately not enumerated as categories they are not.
		'dpv:hasPersonalData': ['pd:Name', 'pd:EmailAddress', 'pd:TelephoneNumber'],
	};
}
