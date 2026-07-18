// W3C Data Privacy Vocabulary (DPV v2.3, namespace https://w3id.org/dpv#) expression of Facet's
// processing. These terms describe DEPLOYMENT behaviour over aggregate data, not any individual: the
// raw IP is transiently derived into a daily-rotating pseudonymous hash and never stored, events are
// aggregated into rollups, and the purpose is service optimisation. Embedded in the
// PrivacyAttestationCredential and served as a machine-readable manifest.

/** DPV namespace + prefix, referenced as the JSON-LD context of the claims. */
export const DPV_CONTEXT = { dpv: 'https://w3id.org/dpv#' } as const;

/** Facet's DPV claims: processing operations, purpose, legal basis, and technical measures. */
export function privacyDpvClaims(): Record<string, unknown> {
	return {
		'@context': DPV_CONTEXT,
		// Collect (events) → Derive (daily visitor hash from IP+UA, transient) → Aggregate (rollups)
		// → Analyse (reports). The raw IP is never stored.
		'dpv:hasProcessing': ['dpv:Collect', 'dpv:Derive', 'dpv:Aggregate', 'dpv:Analyse'],
		'dpv:hasPurpose': 'dpv:ServiceOptimisation',
		'dpv:hasLegalBasis': 'dpv:LegitimateInterest',
		'dpv:hasTechnicalOrganisationalMeasure': ['dpv:Pseudonymisation'],
	};
}
