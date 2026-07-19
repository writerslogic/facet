// Facet's two deployment/dataset credential types, as W3C VC 2.0 documents signed with
// eddsa-jcs-2022 (see vc.ts). Neither describes a person: the PrivacyAttestationCredential attests
// the DEPLOYMENT's build/config/privacy properties, and the AnalyticsReportCredential attests an
// aggregate stats snapshot for a site+range (the DATASET). Builders only assemble the document; the
// caller signs it with `issueCredential`.

import type { VerifiableCredential } from './vc.js';
import { VC_V2_CONTEXT } from './vc.js';

/** Privacy/build/config properties of a deployment (no PII, no per-visitor identifiers). */
export interface DeploymentProperties {
	/** Build identifier (e.g. CI build number or image tag). */
	buildId: string;
	/** Source commit the deployment was built from. */
	commit: string;
	/** SHA-256 (hex) of the declared D1 schema fingerprint. */
	schemaHash: string;
	/** Rolling raw-event retention window in days. */
	retentionDays: number;
	/** The privacy model as machine-readable booleans/labels. */
	privacy: {
		/** The visitor hash scheme (e.g. daily-rotating salted SHA-256). */
		visitorHash: string;
		/** True — the IP is hashed to derive the daily visitor hash. */
		hashesIp: boolean;
		/** False — the raw IP is never stored, logged, or returned. */
		storesRawIp: boolean;
		/** False — Facet sets no cookies. */
		cookies: boolean;
	};
}

export interface PrivacyAttestationInput {
	did: string;
	created: string;
	deployment: DeploymentProperties;
	/** Optional DPV (Data Privacy Vocabulary) claims, embedded by the P3.7 manifest layer. */
	dpv?: Record<string, unknown>;
	/** Optional reference to a RATS process-evidence EAT (P4.10): its profile + content-ref digest. */
	evidence?: { profile: string; contentRef: { alg: string; digest: string } };
	validUntil?: string;
}

/** Build (unsigned) a PrivacyAttestationCredential about the deployment. */
export function buildPrivacyAttestationCredential(
	input: PrivacyAttestationInput,
): VerifiableCredential {
	return {
		'@context': [VC_V2_CONTEXT],
		type: ['VerifiableCredential', 'PrivacyAttestationCredential'],
		issuer: input.did,
		validFrom: input.created,
		...(input.validUntil ? { validUntil: input.validUntil } : {}),
		credentialSubject: {
			id: input.did,
			deployment: input.deployment,
			...(input.dpv ? { dpv: input.dpv } : {}),
			...(input.evidence ? { processEvidence: input.evidence } : {}),
		},
	};
}

export interface AnalyticsReportInput {
	did: string;
	created: string;
	/** The site id the report covers. */
	site: string;
	/** Stable subject identifier for the dataset (e.g. `<origin>/sites/<id>`), never a person. */
	subjectId: string;
	range: { start: number; end: number };
	report: { pageviews: number; visitors: number; events: number };
	validUntil?: string;
}

/** Build (unsigned) an AnalyticsReportCredential over an aggregate stats snapshot. */
export function buildAnalyticsReportCredential(input: AnalyticsReportInput): VerifiableCredential {
	return {
		'@context': [VC_V2_CONTEXT],
		type: ['VerifiableCredential', 'AnalyticsReportCredential'],
		issuer: input.did,
		validFrom: input.created,
		...(input.validUntil ? { validUntil: input.validUntil } : {}),
		credentialSubject: {
			id: input.subjectId,
			site: input.site,
			range: input.range,
			report: input.report,
		},
	};
}
