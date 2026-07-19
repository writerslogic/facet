// Deployment descriptor + credential issuance for the Worker. The descriptor gathers the DEPLOYMENT's
// build/config/privacy properties (never anything about a visitor): a real SHA-256 fingerprint of the
// live D1 schema, the retention window, and the fixed privacy model. Reused by the PrivacyAttestation
// credential (P3.6/P3.7) and the RATS process-evidence attestation (P4.10).

import type { DeploymentProperties, ProcessEvidence } from '@facet/trust';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { DEFAULT_RAW_RETENTION_DAYS } from './constants.js';
import { sha256Hex } from './crypto.js';

let cachedSchemaHash: string | null = null;

/** Every drizzle table exported from the schema module (filters out non-table exports). */
function schemaTables(): unknown[] {
	return Object.values(schema).filter((t) => {
		try {
			return typeof getTableName(t as never) === 'string';
		} catch {
			return false;
		}
	});
}

/** SHA-256 (hex) of a canonical descriptor of the live D1 schema (table + sorted column names). */
export async function schemaFingerprintHash(): Promise<string> {
	if (cachedSchemaHash) return cachedSchemaHash;
	const descriptor = schemaTables()
		.map((t) => ({
			name: getTableName(t as never) as string,
			columns: Object.keys(getTableColumns(t as never)).sort(),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	cachedSchemaHash = await sha256Hex(JSON.stringify(descriptor));
	return cachedSchemaHash;
}

/** Assemble the deployment's build/config/privacy properties for attestation. */
export async function deploymentDescriptor(env: Env): Promise<DeploymentProperties> {
	return {
		buildId: env.FACET_BUILD_ID ?? 'unknown',
		commit: env.FACET_GIT_COMMIT ?? 'unknown',
		schemaHash: await schemaFingerprintHash(),
		retentionDays: Number(env.RAW_RETENTION_DAYS ?? DEFAULT_RAW_RETENTION_DAYS),
		privacy: {
			visitorHash: 'daily-rotating-salted-sha256',
			hashesIp: true,
			storesRawIp: false,
			cookies: false,
		},
	};
}

/** The enabled privacy transforms, as stable labels for RATS process evidence. */
const PRIVACY_TRANSFORMS = [
	'daily-rotating-salted-sha256-visitor-hash',
	'no-raw-ip-storage',
	'cookieless',
	'dnt-honored',
	'gpc-honored',
] as const;

/** Assemble RATS process evidence for the running deployment (software attestation only). */
export async function buildProcessEvidence(env: Env): Promise<ProcessEvidence> {
	return {
		buildId: env.FACET_BUILD_ID ?? 'unknown',
		commit: env.FACET_GIT_COMMIT ?? 'unknown',
		schemaHash: await schemaFingerprintHash(),
		wranglerHash: env.FACET_WRANGLER_HASH ?? 'unknown',
		privacyTransforms: [...PRIVACY_TRANSFORMS],
	};
}
