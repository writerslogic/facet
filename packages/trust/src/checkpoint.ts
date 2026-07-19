// A signed MMR checkpoint (a "signed tree head"): the tree size, the bagged root (hex), and a
// timestamp, signed as a detached-JWS statement. A verifier confirms the signature and can then check
// inclusion/consistency proofs against the checkpoint's root. Commits a DATASET (aggregate rollups).

import type { SigningKey } from './keys.js';
import {
	type SignedStatement,
	type StatementVerification,
	signStatement,
	verifyStatement,
} from './statement.js';

/** Statement type for MMR checkpoints. */
export const CHECKPOINT_TYPE = 'facet-mmr-checkpoint/1' as const;

export interface Checkpoint {
	/** MMR_SHA256 profile identifier the root was computed under. */
	profile: 'MMR_SHA256';
	/** Number of MMR nodes committed. */
	size: number;
	/** Bagged accumulator root, hex-encoded. */
	root: string;
	/** ISO 8601 checkpoint time. */
	timestamp: string;
}

/** Sign a checkpoint as a detached-JWS statement. */
export function signCheckpoint(
	checkpoint: Checkpoint,
	key: SigningKey,
	now: number,
): Promise<SignedStatement<Checkpoint>> {
	return signStatement(CHECKPOINT_TYPE, checkpoint, key, now);
}

/** Verify a signed checkpoint's signature (offline, against the embedded key). */
export function verifyCheckpoint(
	stmt: SignedStatement<Checkpoint>,
): Promise<StatementVerification> {
	return verifyStatement(stmt, CHECKPOINT_TYPE);
}
