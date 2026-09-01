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

type DpvClaims = {
	'@context': typeof DPV_CONTEXT | typeof DPV_PD_CONTEXT;
	'dpv:hasProcessing': string[];
	'dpv:hasPurpose': string | string[];
	'dpv:hasLegalBasis': string | string[];
	'dpv:hasTechnicalOrganisationalMeasure': string[];
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
 * With the CRM bound, three things stop being true and the claims say so:
 *   • `dpv:Store` and `dpv:Erase` join the processing set — contact details are retained as a
 *     business record (deliberately NOT on the raw-event retention schedule) and erased on request.
 *   • `dpv:Consent` joins the legal basis — the contact→analytics link is authorized only by an
 *     active signed consent record, never by legitimate interest.
 *   • Pseudonymisation stops being the sole measure. It still describes the analytics half, but
 *     directly-supplied contact details are not pseudonymised; what protects them is access control
 *     (an authenticated operator session with a team role, never an API key) and a record of every
 *     access made under it, so both are named alongside it rather than letting one term imply
 *     coverage it does not have.
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
		'dpv:hasLegalBasis': ['dpv:LegitimateInterest', 'dpv:Consent'],
		'dpv:hasTechnicalOrganisationalMeasure': [
			'dpv:Pseudonymisation',
			'dpv:AccessControlMethod',
			// The CRM audit log: every authorized request against the contact store is recorded before
			// it runs. `dpv:ActivityMonitoring` rather than `dpv:RecordsOfActivities`, which in DPV sits
			// with ROPA and the other compliance documents — this is a live access log, not a register
			// of processing. Claimed only on the CRM branch because it is the only data this deployment
			// holds that a person can read one record at a time, and therefore the only data where who
			// looked is a fact worth keeping.
			'dpv:ActivityMonitoring',
		],
		'dpv:hasDataSubject': 'dpv:Customer',
		// The categories the contact schema has columns for. Free-text fields an operator may fill
		// with anything are deliberately not enumerated as categories they are not.
		//
		// `pd:CurrentEmployment` is here because of `companies`, and the distinction is real rather
		// than pedantic. A `company` string an operator typed into a box is free text, which is why it
		// was not enumerated before; a `company_id` pointing at an organization record makes this
		// person's employer a structured attribute the deployment can query and join on. The company
		// row itself is NOT personal data — an organization is a legal person, and its name and domain
		// are nobody's — so what is declared is the contact's employment, not the company table.
		'dpv:hasPersonalData': [
			'pd:Name',
			'pd:EmailAddress',
			'pd:TelephoneNumber',
			'pd:CurrentEmployment',
			// `deals.contact_id` links a monetary pipeline value to a named person. `pd:Transactional`
			// ("information about a purchasing, spending or income") is the DPV term for that, and it is
			// claimed unconditionally once `deals` exists — same structural-capability reasoning as
			// `pd:CurrentEmployment` above, since most contacts will have no deal at all.
			'pd:Transactional',
		],
	};
}
