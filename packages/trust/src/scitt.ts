// SCITT (draft-ietf-scitt-architecture) formats: a Signed Statement and a Receipt. IMPORTANT: the
// canonical SCITT serialization is COSE_Sign1; a COSE variant is format-ready but gated on a
// workerd-verified COSE library (see the trust README), so these are the JWS-based equivalents. A
// Signed Statement is any payload signed by the issuer; a Receipt is issued by a Transparency Service
// on Registration and proves the statement's inclusion in the service's append-only log. The FORMAT +
// verification live here; a local Transparency-Service double and a pluggable external client live in
// @facet/server. Operating a production Transparency Service is a deployment concern, not a Facet
// feature.

import type { SigningKey } from './keys.js';
import type { InclusionReceipt } from './receipt.js';
import { verifyInclusionReceipt } from './receipt.js';
import {
	type SignedStatement,
	type StatementVerification,
	signStatement,
	signStatementCose,
	verifyStatement,
} from './statement.js';

/** SCITT Signed Statement type identifier. */
export const SCITT_SIGNED_STATEMENT = 'scitt-signed-statement/1' as const;

/** SCITT Receipt type identifier. */
export const SCITT_RECEIPT = 'scitt-receipt/1' as const;

/** Sign a payload as a SCITT Signed Statement (detached-JWS proof, for HTTP contexts). */
export function signSignedStatement<T>(
	payload: T,
	key: SigningKey,
	now: number,
): Promise<SignedStatement<T>> {
	return signStatement(SCITT_SIGNED_STATEMENT, payload, key, now);
}

/** Sign a payload as a SCITT Signed Statement with a COSE_Sign1 proof (the SCITT-native wire form). */
export function signSignedStatementCose<T>(
	payload: T,
	key: SigningKey,
	now: number,
): Promise<SignedStatement<T>> {
	return signStatementCose(SCITT_SIGNED_STATEMENT, payload, key, now);
}

/** Verify a SCITT Signed Statement's signature (offline, against its embedded key). */
export function verifySignedStatement(stmt: SignedStatement): Promise<StatementVerification> {
	return verifyStatement(stmt, SCITT_SIGNED_STATEMENT);
}

/** The payload of a SCITT Receipt: proof the statement was registered in the service's MMR log. */
export interface ScittReceiptPayload {
	/** Identifier of the Transparency Service log. */
	logId: string;
	/** Zero-based registration sequence number in the log. */
	entryId: number;
	/** Hex SHA-256 of the canonical Signed Statement that was registered. */
	statementHash: string;
	/** The service MMR tree size at registration. */
	treeSize: number;
	/** The service MMR bagged root (hex) the inclusion proof commits to. */
	root: string;
	/** MMR inclusion proof for this statement's leaf against `root`. */
	inclusion: InclusionReceipt;
	/** ISO 8601 registration time. */
	registeredAt: string;
}

/** Sign a SCITT Receipt payload in the requested wire form (`jws` default, or `cose`). */
export function signScittReceipt(
	payload: ScittReceiptPayload,
	key: SigningKey,
	now: number,
	format: 'jws' | 'cose' = 'jws',
): Promise<SignedStatement<ScittReceiptPayload>> {
	return format === 'cose'
		? signStatementCose(SCITT_RECEIPT, payload, key, now)
		: signStatement(SCITT_RECEIPT, payload, key, now);
}

export interface ScittReceiptVerification {
	valid: boolean;
	logId?: string;
	entryId?: number;
	reason?: string;
}

/**
 * Verify a SCITT Receipt: the Transparency Service's signature over the receipt must verify, and the
 * embedded MMR inclusion proof must fold to the receipt's committed root. The caller separately
 * checks that `statementHash` matches the Signed Statement they hold.
 */
export async function verifyScittReceipt(
	receipt: SignedStatement<ScittReceiptPayload>,
): Promise<ScittReceiptVerification> {
	const sig = await verifyStatement(receipt, SCITT_RECEIPT);
	const p = receipt.payload;
	if (!sig.valid)
		return {
			valid: false,
			logId: p?.logId,
			entryId: p?.entryId,
			reason: sig.reason,
		};
	const included = await verifyInclusionReceipt(p.inclusion, p.root);
	if (!included) {
		return {
			valid: false,
			logId: p.logId,
			entryId: p.entryId,
			reason: 'inclusion proof failed',
		};
	}
	return { valid: true, logId: p.logId, entryId: p.entryId };
}
