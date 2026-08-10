// Transparency-log proofs for the dashboard. Two questions: does this deployment run a signed MMR log
// (the checkpoint / tree head), and what is the inclusion proof for a specific rollup bucket. Proofs are
// fetched lazily — only when a proof drawer opens — so they never weigh down initial page load. Types
// mirror the JSON the Worker returns; we keep them local (not `@facet/trust`) so the trust package's
// jose/cborg never enter the browser bundle.
//
// `useProvenance` goes further: it actually RUNS the verification. The code that does so
// (lib/provenance.ts, which pulls in the MMR primitives and `jose`) is reached only through a dynamic
// import inside the query function, so none of it is in the initial chunk — a page that never opens a
// proof drawer never downloads a byte of it.

import { useQuery } from '@tanstack/react-query';
import type { LeafClaim, ProvenanceResult } from '../lib/provenance.js';
import { siteQueryKey } from '../lib/queryKeys.js';

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
		queryKey: siteQueryKey('transparency-inclusion', siteId, ref),
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

export type { LeafClaim, ProvenanceResult } from '../lib/provenance.js';

/**
 * Run the full chain-of-custody verification for one metric. Enabled only while a proof panel is
 * open, so the crypto bundle and the three network round-trips are paid for on demand.
 *
 * `runProvenance` never rejects — every failure mode is a described state in the result — so the
 * query has no error branch to render and `retry` is off: re-running a cryptographic check that
 * already returned a verdict would only reproduce it.
 */
export function useProvenance(
	apiKey: string,
	siteId: string,
	ref: ProofRef | null,
	claim: LeafClaim | null,
	enabled: boolean,
) {
	return useQuery<ProvenanceResult>({
		queryKey: siteQueryKey('provenance', siteId, ref, claim),
		queryFn: async () => {
			const { runProvenance } = await import('../lib/provenance.js');
			return runProvenance({ apiKey, siteId, ref, claim });
		},
		enabled: enabled && Boolean(apiKey),
		retry: false,
		staleTime: 5 * 60 * 1000,
	});
}
