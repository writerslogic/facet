// Deployment descriptor + credential issuance for the Worker. The descriptor gathers the DEPLOYMENT's
// build/config/privacy properties (never anything about a visitor): a real SHA-256 fingerprint of the
// live D1 schema, the retention window, and the fixed privacy model. Reused by the PrivacyAttestation
// credential (P3.6/P3.7) and the RATS process-evidence attestation (P4.10).

import type { DeploymentProperties } from '@facet/trust';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { DEFAULT_RAW_RETENTION_DAYS } from './constants.js';

let cachedSchemaHash: string | null = null;

/** Hex-encode bytes. */
function hex(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

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
	const bytes = new TextEncoder().encode(JSON.stringify(descriptor));
	cachedSchemaHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
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
