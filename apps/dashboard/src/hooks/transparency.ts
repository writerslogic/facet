// Transparency-log proofs for the dashboard. Two questions: does this deployment run a signed MMR log
// (the checkpoint / tree head), and what is the inclusion proof for a specific rollup bucket. Proofs are
// fetched lazily — only when a proof drawer opens — so they never weigh down initial page load. Types
// mirror the JSON the Worker returns; we keep them local (not `@facet/trust`) so the trust package's
// jose/cborg never enter the browser bundle.

import { useQuery } from '@tanstack/react-query';

/** A signed MMR checkpoint (tree head), from GET /api/transparency/checkpoint. Null when the log is
 * unconfigured (no deployment signing key). */
export interface SignedCheckpoint {
	statement: string;
	payload: { profile: string; size: number; root: string; timestamp: string };
	proof: {
		type: string;
		alg: string;
		kid: string;
		publicJwk: { kty: string; crv?: string; x?: string; alg?: string };
		created: string;
		jws?: string;
		cose?: string;
	};
}

/** An MMR inclusion receipt (hex-encoded), from GET /api/transparency/inclusion. */
export interface InclusionReceipt {
	index: number;
	leaf: string;
	path: string[];
	size: number;
	peaks: string[];
}

export interface InclusionProof {
	rollup_key: string;
	size: number;
	root: string;
	receipt: InclusionReceipt;
}

/** Coordinates of the rollup bucket a metric is derived from — the unit the MMR log commits. A KPI that
 * aggregates a whole range spans many rollups and so has no single ref; per-bucket metrics do. */
export interface ProofRef {
	hostname: string;
	bucketStart: number;
	interval: 'hour' | 'day';
}

/** GET that treats 404 as a null result (checkpoint absent / bucket not yet logged), not an error. */
async function fetchMaybe<T>(path: string, apiKey: string): Promise<T | null> {
	const res = await fetch(path, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (res.status === 404) return null;
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? 'request_failed');
	}
	return (await res.json()) as T;
}

/** Whether this deployment maintains a signed transparency log, plus the latest tree head. `null` when
 * the log is unconfigured. Cached long — the checkpoint only moves on the hourly cron, and React Query
 * dedupes so every VerifiedMetric on the page shares this single request. */
export function useCheckpoint(apiKey: string) {
	return useQuery({
		// Keyed by apiKey so a profile switch fetches the new deployment's checkpoint rather than serving
		// the previous one from cache (the checkpoint is a per-deployment artifact). Every VerifiedMetric on
		// a page uses the same apiKey, so the intended dedupe within a profile is preserved.
		queryKey: ['transparency-checkpoint', apiKey],
		queryFn: () => fetchMaybe<SignedCheckpoint>('/api/transparency/checkpoint', apiKey),
		enabled: Boolean(apiKey),
		staleTime: 5 * 60 * 1000,
	});
}

/** Lazily fetch the inclusion proof for one rollup bucket. Runs only when `ref` is set (i.e. a drawer is
 * open). A `null` result means the bucket is not yet in the log — recent buckets are committed on the
 * next hourly cron, so a just-elapsed hour legitimately has no proof for a few minutes. */
export function useInclusionProof(apiKey: string, siteId: string, ref: ProofRef | null) {
	return useQuery({
		queryKey: ['transparency-inclusion', siteId, ref],
		queryFn: () => {
			const r = ref as ProofRef;
			const params = new URLSearchParams({
				site_id: siteId,
				hostname: r.hostname,
				bucket_start: String(r.bucketStart),
				interval: r.interval,
			});
			return fetchMaybe<InclusionProof>(`/api/transparency/inclusion?${params}`, apiKey);
		},
		enabled: Boolean(apiKey && siteId && ref),
		staleTime: 5 * 60 * 1000,
	});
}
