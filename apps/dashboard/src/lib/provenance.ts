// The chain-of-custody verifier: it fetches every artifact the deployment publishes about a number and
// RUNS the checks rather than displaying them. The checkpoint's detached JWS is verified against its
// embedded key, that key is matched to the one this domain publishes, the build attestation is
// verified and digest-bound, the figures on screen are re-hashed into a Merkle leaf, and the inclusion
// path is re-folded to the signed root. A link that could not be checked is reported as unchecked —
// never as a pass. The cryptography itself lives in provenanceCrypto.ts (which also explains why it is
// a local re-derivation rather than an @facet/trust import).
//
// This module is only ever reached through a dynamic import (see hooks/transparency.ts), so none of it
// is in the initial bundle: opening a proof panel is what downloads it.

import type { InclusionProof, ProofRef, SignedCheckpoint } from '../hooks/transparency.js';
import {
	type FoldStep,
	baggedRoot,
	canonicalDigestHex,
	canonicalizeBytes,
	foldPath,
	fromHex,
	leafHash,
	toHex,
	verifyInclusionReceipt,
	verifyStatementProof,
} from './provenanceCrypto.js';

/** The figures a card is showing, so the leaf hash can be recomputed from what the reader can see.
 * Without this the log can be proven sound but nothing binds it to the number on screen. */
export interface LeafClaim {
	siteId: string;
	pageviews: number;
	visitors: number;
	events: number;
}

/** Per-link outcome. `pass`/`fail` are verdicts we computed; `warn` is a check that could not be
 * completed; `info` is a link that does not apply; `skip` is a link this deployment does not offer. */
export type LinkStatus = 'pass' | 'fail' | 'warn' | 'info' | 'skip';

/** One link of the custody chain, in reading order. */
export interface ProvenanceLink {
	id: 'number' | 'signature' | 'key' | 'build' | 'record' | 'inclusion';
	title: string;
	status: LinkStatus;
	/** One sentence for someone who has never heard of a Merkle tree. */
	plain: string;
	/** What was actually checked, or precisely why it could not be. */
	detail: string;
	/** True only when this link's status came from cryptography executed in this browser. */
	checked: boolean;
	/** Copyable proof material for this link. */
	fields: { label: string; value: string; mono?: boolean }[];
}

export type { FoldStep } from './provenanceCrypto.js';

/** Everything the Merkle visualization needs, all of it recomputed here. */
export interface FoldResult {
	leaf: string;
	steps: FoldStep[];
	/** The accumulator peak the walk lands on. */
	peak: string;
	peaks: string[];
	/** Index into `peaks` the walk matched, or null when it matched none (a failing proof). */
	matchedPeak: number | null;
	/** Root recomputed from the peaks. */
	computedRoot: string;
	/** The root this proof was checked against. */
	anchorRoot: string;
	/** Whether `anchorRoot` is a root the deployment actually signed. */
	anchorSigned: boolean;
	size: number;
}

export type Verdict = 'verified' | 'failed' | 'partial' | 'unsigned' | 'unavailable';

export interface ProvenanceResult {
	verdict: Verdict;
	/** Headline for the verdict — the only place the word "verified" is allowed to appear. */
	headline: string;
	/** Plain-language expansion of the headline. */
	summary: string;
	links: ProvenanceLink[];
	fold: FoldResult | null;
	checkpoint: SignedCheckpoint | null;
	proof: InclusionProof | null;
	/** Build/commit the deployment attested to, when it publishes attestation. */
	build: { buildId: string; commit: string; schemaHash: string } | null;
}

export interface ProvenanceRequest {
	apiKey: string;
	siteId: string;
	/** The rollup bucket behind the number, when it is a single bucket. */
	ref?: ProofRef | null;
	/** The figures on screen, so they can be bound to the logged leaf. */
	claim?: LeafClaim | null;
	/** Injected by tests. */
	fetchImpl?: typeof fetch;
}

// ————————————————————————————————————————————————————————————————————————————————————————————————
// Fetching. Each HTTP outcome maps to a DISTINCT kind, because "no signing key configured" (404/501),
// "not your site" (403) and "the network is down" are three different truths that must not collapse
// into one grey "couldn't verify".

type Fetched<T> =
	| { kind: 'ok'; value: T }
	| { kind: 'missing' }
	| { kind: 'forbidden' }
	| { kind: 'unimplemented' }
	| { kind: 'error'; message: string };

async function getJson<T>(
	url: string,
	fetchImpl: typeof fetch,
	apiKey?: string,
): Promise<Fetched<T>> {
	try {
		const res = await fetchImpl(url, {
			credentials: 'same-origin',
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
		});
		if (res.status === 404) return { kind: 'missing' };
		if (res.status === 401 || res.status === 403) return { kind: 'forbidden' };
		if (res.status === 501) return { kind: 'unimplemented' };
		if (!res.ok) return { kind: 'error', message: `HTTP ${res.status}` };
		return { kind: 'ok', value: (await res.json()) as T };
	} catch (e) {
		return {
			kind: 'error',
			message: e instanceof Error ? e.message : 'network request failed',
		};
	}
}

// ————————————————————————————————————————————————————————————————————————————————————————————————
// Individual checks.

interface Jwks {
	keys: { kid?: string; kty?: string; crv?: string; x?: string; y?: string }[];
}

interface SignedEvidence {
	statement?: string;
	payload?: {
		'process-evidence'?: { buildId: string; commit: string; schemaHash: string };
		'content-ref'?: { alg: string; digest: string };
		'key-attributes'?: { hardware: boolean; extractable: boolean; software: boolean };
	};
	proof?: SignedCheckpoint['proof'];
}

/** Verify the checkpoint's signature over the RFC 8785 canonical bytes of its own payload. */
async function checkSignature(checkpoint: SignedCheckpoint): Promise<ProvenanceLink> {
	const base = {
		id: 'signature' as const,
		title: 'Signed by the deployment key',
		plain: 'The summary of the log carries a signature that only this deployment’s private key could produce.',
		fields: [
			{ label: 'Algorithm', value: checkpoint.proof.alg },
			{ label: 'Key id (JWK thumbprint)', value: checkpoint.proof.kid, mono: true },
			{
				label: 'Public key (JWK)',
				value: JSON.stringify(checkpoint.proof.publicJwk),
				mono: true,
			},
			...(checkpoint.proof.jws
				? [{ label: 'Detached JWS', value: checkpoint.proof.jws, mono: true }]
				: []),
		],
	};
	// A COSE_Sign1 proof would need a CBOR decoder that is only a dev dependency of the trust package;
	// shipping it to the browser is not on, and pretending to have checked it is worse.
	if (checkpoint.proof.type === 'COSE_Sign1') {
		return {
			...base,
			status: 'warn',
			checked: false,
			detail: 'This checkpoint carries a COSE_Sign1 signature. The browser build does not include a CBOR decoder, so the signature was not checked here — verify it offline with `facet verify`.',
		};
	}
	const check = await verifyStatementProof(checkpoint.proof, checkpoint.payload);
	if (check.ok) {
		return {
			...base,
			status: 'pass',
			checked: true,
			detail: `The ${checkpoint.proof.alg} signature over the tree head verified in this browser against the public key shipped with it, and the key id is that key’s RFC 7638 thumbprint — so the label cannot be swapped for another key’s.`,
		};
	}
	// "Your browser cannot do this arithmetic" is not "the signature is bad". Conflating them would
	// accuse an honest deployment of forgery on an old browser.
	if (check.unsupported) {
		return {
			...base,
			status: 'warn',
			checked: false,
			detail: `The signature was NOT checked: ${check.reason}. Try a current browser, or verify offline with \`facet verify\`.`,
		};
	}
	return {
		...base,
		status: 'fail',
		checked: true,
		detail: `The signature did not verify: ${check.reason ?? 'unknown reason'}. Treat every number on this page as unproven.`,
	};
}

/** Confirm the signing key is one this domain publishes, not merely one that came with the payload. */
async function checkPublishedKey(
	checkpoint: SignedCheckpoint,
	fetchImpl: typeof fetch,
): Promise<ProvenanceLink> {
	const base = {
		id: 'key' as const,
		title: 'That key is published at this domain',
		plain: 'Anybody can download this site’s public key and repeat the check without asking us for anything.',
	};
	const jwks = await getJson<Jwks>('/.well-known/jwks.json', fetchImpl);
	if (jwks.kind !== 'ok') {
		return {
			...base,
			status: 'warn',
			checked: false,
			detail:
				jwks.kind === 'missing'
					? 'This deployment publishes no key set at /.well-known/jwks.json, so the signing key could not be matched to a published one.'
					: `Could not read /.well-known/jwks.json (${jwks.kind === 'error' ? jwks.message : jwks.kind}), so the signing key could not be matched to a published one.`,
			fields: [{ label: 'Key set', value: '/.well-known/jwks.json' }],
		};
	}
	const kids = jwks.value.keys.map((k) => k.kid).filter((k): k is string => Boolean(k));
	const found = kids.includes(checkpoint.proof.kid);
	return {
		...base,
		status: found ? 'pass' : 'fail',
		checked: true,
		detail: found
			? 'The key that signed this checkpoint is listed in the key set this deployment serves at /.well-known/jwks.json.'
			: 'The signing key is NOT in the key set this deployment publishes. The signature is internally consistent, but it was made by a key this domain does not admit to owning.',
		fields: [
			{ label: 'Key set', value: '/.well-known/jwks.json' },
			{ label: 'Published key ids', value: kids.join(', ') || '(none)', mono: true },
		],
	};
}

/** Verify the deployment's signed build attestation and bind it to the same key as the checkpoint. */
async function checkBuild(
	checkpoint: SignedCheckpoint,
	fetchImpl: typeof fetch,
): Promise<{ link: ProvenanceLink; build: ProvenanceResult['build'] }> {
	const base = {
		id: 'build' as const,
		title: 'Produced by an attested build',
		plain: 'The deployment signs a statement saying exactly which build and commit is running, so the code behind the number is pinned too.',
	};
	const ev = await getJson<SignedEvidence>('/api/attestation/evidence', fetchImpl);
	if (ev.kind !== 'ok') {
		return {
			build: null,
			link: {
				...base,
				status: ev.kind === 'unimplemented' || ev.kind === 'missing' ? 'skip' : 'warn',
				checked: false,
				detail:
					ev.kind === 'unimplemented' || ev.kind === 'missing'
						? 'This deployment does not publish build attestation. It is optional and needs an Ed25519 signing key; the log checks below are unaffected.'
						: `Could not read the build attestation (${ev.kind === 'error' ? ev.message : ev.kind}).`,
				fields: [],
			},
		};
	}
	const payload = ev.value.payload;
	const evidence = payload?.['process-evidence'];
	const proof = ev.value.proof;
	const fields = evidence
		? [
				{ label: 'Build id', value: evidence.buildId, mono: true },
				{ label: 'Commit', value: evidence.commit, mono: true },
				{ label: 'Schema fingerprint', value: evidence.schemaHash, mono: true },
			]
		: [];
	if (!proof || proof.type !== 'DetachedJWS' || !evidence) {
		return {
			build: null,
			link: {
				...base,
				status: 'warn',
				checked: false,
				detail: 'The build attestation came back in a form this browser build cannot check (no detached-JWS proof). Verify it offline with `facet verify`.',
				fields,
			},
		};
	}
	const check = await verifyStatementProof(proof, payload);
	if (!check.ok) {
		return {
			build: null,
			link: {
				...base,
				status: check.unsupported ? 'warn' : 'fail',
				checked: !check.unsupported,
				detail: check.unsupported
					? `The build attestation was NOT checked: ${check.reason}.`
					: `The build attestation’s signature did not verify: ${check.reason ?? 'unknown reason'}.`,
				fields,
			},
		};
	}
	// The EAT commits to a digest of its own process-evidence; recompute it, else the claims block
	// could be edited while the signature still covered the untouched digest field.
	const digest = await canonicalDigestHex(evidence);
	if (payload?.['content-ref']?.digest !== digest) {
		return {
			build: null,
			link: {
				...base,
				status: 'fail',
				checked: true,
				detail: 'The attestation’s signature verified, but the build claims do not match the digest it commits to. The claims have been altered.',
				fields,
			},
		};
	}
	const sameKey = proof.kid === checkpoint.proof.kid;
	return {
		build: evidence,
		link: {
			...base,
			status: sameKey ? 'pass' : 'warn',
			checked: true,
			detail: sameKey
				? 'The attestation’s signature verified here, its build claims match the digest it commits to, and it was signed by the same key as the transparency log.'
				: 'The attestation verified, but it was signed by a different key than the transparency log, so the two statements do not provably come from the same signer.',
			fields: [
				...fields,
				{ label: 'Attestation key id', value: proof.kid, mono: true },
				...(payload?.['key-attributes']
					? [
							{
								label: 'Key protection',
								value: payload['key-attributes'].hardware
									? 'hardware-backed (attested)'
									: 'software key',
							},
						]
					: []),
			],
		},
	};
}

/** Re-hash the figures on screen into a leaf and compare with the leaf the log recorded. */
async function checkNumber(
	ref: ProofRef | null | undefined,
	claim: LeafClaim | null | undefined,
	proof: InclusionProof | null,
): Promise<ProvenanceLink> {
	const base = {
		id: 'number' as const,
		title: 'The number you are looking at',
		plain: 'The figures on this card are hashed into a single fingerprint, and that exact fingerprint is what the log stores.',
	};
	if (!ref || !claim || !proof) {
		// Three different reasons, three different sentences. Collapsing them into one grey "not
		// checked" would leave the reader unable to tell a missing proof from an unsupported metric.
		const detail = !ref
			? 'This figure spans many hourly records, so no single log entry corresponds to it. The log commits each hourly record separately; the checks below prove the log those records live in.'
			: !claim
				? 'This view did not hand the proof panel its underlying figures, so the number itself is not bound to a log entry here. Everything below still proves the log.'
				: 'The figures could not be compared to the log because no inclusion proof was available for this hour — see the record link below for why.';
		return { ...base, status: 'info', checked: false, detail, fields: [] };
	}
	// Exactly the leaf the Worker commits (see server lib/transparency.ts rollupLeafBytes) — the same
	// field names, in RFC 8785 canonical form, hashed with SHA-256.
	const record = {
		site_id: claim.siteId,
		hostname: ref.hostname,
		bucket_start: ref.bucketStart,
		interval: ref.interval,
		pageviews: claim.pageviews,
		events: claim.events,
		visitors: claim.visitors,
	};
	const recomputed = toHex(await leafHash(canonicalizeBytes(record)));
	const match = recomputed === proof.receipt.leaf;
	return {
		...base,
		status: match ? 'pass' : 'fail',
		checked: true,
		detail: match
			? 'The figures shown here were re-hashed in this browser and the result is byte-for-byte the record stored in the log. Change any one of them and this stops matching.'
			: 'The figures shown here do NOT hash to the record stored in the log. Either the display or the record has changed since it was written.',
		fields: [
			{ label: 'Record', value: JSON.stringify(record), mono: true },
			{ label: 'Hash of the record shown', value: recomputed, mono: true },
			{ label: 'Hash recorded in the log', value: proof.receipt.leaf, mono: true },
		],
	};
}

// ————————————————————————————————————————————————————————————————————————————————————————————————

const UNSIGNED_SUMMARY =
	'Nothing is broken. Signing is optional: without a signing key this deployment keeps no transparency log, so no number here claims to be provable. Numbers come straight from the database, like any other analytics tool.';

function shell(
	verdict: Verdict,
	headline: string,
	summary: string,
	links: ProvenanceLink[],
	checkpoint: SignedCheckpoint | null = null,
): ProvenanceResult {
	return { verdict, headline, summary, links, fold: null, checkpoint, proof: null, build: null };
}

/** Links to show when there is no log at all — stated, not greyed out silently. */
function dormantLinks(detail: string): ProvenanceLink[] {
	return (
		[
			['number', 'The number you are looking at'],
			['signature', 'Signed by the deployment key'],
			['key', 'That key is published at this domain'],
			['build', 'Produced by an attested build'],
			['record', 'Recorded in the transparency log'],
			['inclusion', 'Provable against the signed tree head'],
		] as const
	).map(([id, title]) => ({
		id,
		title,
		status: 'skip' as const,
		plain: '',
		detail,
		checked: false,
		fields: [],
	}));
}

/**
 * Run every check in the chain. Never throws and never reports a pass it did not compute: each link
 * carries `checked`, and the caller must not render a tick for `checked === false`.
 */
export async function runProvenance(req: ProvenanceRequest): Promise<ProvenanceResult> {
	const fetchImpl = req.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const cp = await getJson<SignedCheckpoint>(
		'/api/transparency/checkpoint',
		fetchImpl,
		req.apiKey,
	);
	if (cp.kind === 'missing' || cp.kind === 'unimplemented') {
		return shell(
			'unsigned',
			'This deployment does not sign its data',
			UNSIGNED_SUMMARY,
			dormantLinks(
				'No signing key is configured, so this step does not exist on this deployment.',
			),
		);
	}
	if (cp.kind !== 'ok') {
		const why =
			cp.kind === 'forbidden'
				? 'The transparency log refused this API key.'
				: `The transparency log could not be reached (${cp.message}).`;
		return shell(
			'unavailable',
			'Could not reach the transparency log',
			`${why} Nothing has been verified — this is a connection problem, not a verdict about the data.`,
			dormantLinks('Not attempted: the transparency log could not be reached.'),
		);
	}
	const checkpoint = cp.value;

	// The three deployment-level checks are independent; run them together.
	const [signature, key, buildCheck] = await Promise.all([
		checkSignature(checkpoint),
		checkPublishedKey(checkpoint, fetchImpl),
		checkBuild(checkpoint, fetchImpl),
	]);

	const links: ProvenanceLink[] = [];
	let proof: InclusionProof | null = null;
	let fold: FoldResult | null = null;
	let record: ProvenanceLink;
	let inclusion: ProvenanceLink;

	const recordBase = {
		id: 'record' as const,
		title: 'Recorded in the transparency log',
		plain: 'The record sits at a fixed position in an append-only list. Positions never move and entries are never rewritten.',
	};
	const inclusionBase = {
		id: 'inclusion' as const,
		title: 'Provable against the signed tree head',
		plain: 'Combining the record with a handful of neighbouring fingerprints reproduces the exact summary the deployment signed. Alter any record anywhere in the log and it stops reproducing.',
	};

	if (!req.ref) {
		record = {
			...recordBase,
			status: 'info',
			checked: false,
			detail: 'This figure aggregates many hourly records rather than being one of them, so there is no single position to look up. The log still commits every hour it covers.',
			fields: [
				{ label: 'Log size (nodes)', value: String(checkpoint.payload.size) },
				{ label: 'Signed root', value: checkpoint.payload.root, mono: true },
			],
		};
		inclusion = {
			...inclusionBase,
			status: 'info',
			checked: false,
			detail: 'An inclusion proof applies to one record. Open the proof from an hourly figure to walk one.',
			fields: [],
		};
	} else {
		const params = new URLSearchParams({
			site_id: req.siteId,
			hostname: req.ref.hostname,
			bucket_start: String(req.ref.bucketStart),
			interval: req.ref.interval,
		});
		const inc = await getJson<InclusionProof>(
			`/api/transparency/inclusion?${params}`,
			fetchImpl,
			req.apiKey,
		);
		if (inc.kind !== 'ok') {
			const detail =
				inc.kind === 'missing'
					? 'This hour is not in the log yet. Records are committed on the next hourly checkpoint, so a just-finished hour legitimately has no entry for a few minutes.'
					: inc.kind === 'forbidden'
						? 'Inclusion proofs are scoped to a site: only that site’s own API key can read them. This profile’s key is not authorised for this site.'
						: `The inclusion proof could not be fetched (${inc.kind === 'error' ? inc.message : inc.kind}).`;
			record = { ...recordBase, status: 'warn', checked: false, detail, fields: [] };
			inclusion = {
				...inclusionBase,
				status: 'warn',
				checked: false,
				detail: 'Not attempted: there is no inclusion proof to check.',
				fields: [],
			};
		} else {
			proof = inc.value;
			record = {
				...recordBase,
				status: 'pass',
				checked: false,
				detail: `The log holds this hour at node position ${proof.receipt.index} of ${proof.receipt.size}. The proof below is what makes that position binding.`,
				fields: [
					{ label: 'Record key', value: proof.rollup_key, mono: true },
					{ label: 'Position in the log', value: String(proof.receipt.index) },
					{ label: 'Log size (nodes)', value: String(proof.receipt.size) },
				],
			};
			// The inclusion endpoint proves against the CURRENT tree, which may have grown past the last
			// signed head. Verifying against an unsigned root would be a proof of nothing, so say which
			// root was used and whether a signature stands behind it.
			const anchorSigned = proof.root === checkpoint.payload.root;
			const anchorRoot = anchorSigned ? checkpoint.payload.root : proof.root;
			const ok = await verifyInclusionReceipt(proof.receipt, anchorRoot);
			const steps = await foldPath(
				proof.receipt.index,
				fromHex(proof.receipt.leaf),
				proof.receipt.path.map(fromHex),
			);
			const peakHex = steps.length
				? (steps[steps.length - 1] as FoldStep).to
				: proof.receipt.leaf;
			const matched = proof.receipt.peaks.indexOf(peakHex);
			const computedRoot = toHex(
				await baggedRoot(proof.receipt.size, proof.receipt.peaks.map(fromHex)),
			);
			fold = {
				leaf: proof.receipt.leaf,
				steps,
				peak: peakHex,
				peaks: proof.receipt.peaks,
				matchedPeak: matched >= 0 ? matched : null,
				computedRoot,
				anchorRoot,
				anchorSigned,
				size: proof.receipt.size,
			};
			// Our own walk must agree with the trust package's verifier. If it does not, something is
			// wrong with this code, and the honest output is a failure rather than a tick.
			const walkAgrees = (matched >= 0 && computedRoot === anchorRoot) === ok;
			const fields = [
				{ label: 'Recomputed root', value: computedRoot, mono: true },
				{ label: 'Root checked against', value: anchorRoot, mono: true },
				{ label: 'Path length', value: `${steps.length} sibling hashes` },
			];
			if (!walkAgrees) {
				inclusion = {
					...inclusionBase,
					status: 'fail',
					checked: true,
					detail: 'The two independent recomputations of this proof disagree. That is a bug in this page, not a verdict about the data — do not trust either answer; verify offline with `facet verify`.',
					fields,
				};
			} else if (!ok) {
				inclusion = {
					...inclusionBase,
					status: 'fail',
					checked: true,
					detail: 'The record and its sibling hashes do NOT reproduce the root the deployment published. This proof does not hold.',
					fields,
				};
			} else if (!anchorSigned) {
				inclusion = {
					...inclusionBase,
					status: 'warn',
					checked: true,
					detail: `The proof reproduces the root of a tree of ${proof.receipt.size} nodes, but the newest SIGNED tree head covers ${checkpoint.payload.size}. The arithmetic is sound; no signature stands behind this root yet. The next hourly checkpoint will sign it.`,
					fields,
				};
			} else {
				inclusion = {
					...inclusionBase,
					status: 'pass',
					checked: true,
					detail: `Recomputed ${steps.length} SHA-256 combinations in this browser, from the record up to the accumulator peak, then hashed the peaks together. The result is exactly the root the deployment signed.`,
					fields,
				};
			}
		}
	}

	const number = await checkNumber(req.ref, req.claim, proof);
	links.push(number, signature, key, buildCheck.link, record, inclusion);

	const failed = links.filter((l) => l.status === 'fail');
	const proven = links.filter((l) => l.status === 'pass' && l.checked);
	// A link that could not be checked ('warn') is the reason the headline may not say "verified".
	// `skip` and `info` are different: they are links this deployment does not have, or that do not
	// apply to this figure, and neither is a gap in what WAS established.
	const unchecked = links.filter((l) => l.status === 'warn');
	let verdict: Verdict;
	let headline: string;
	let summary: string;
	if (failed.length > 0) {
		verdict = 'failed';
		headline = 'Verification failed';
		summary = `${failed.length === 1 ? 'One check' : `${failed.length} checks`} did not pass. Read the failing link below: this number cannot be shown to be the one the deployment committed to.`;
	} else if (
		signature.status === 'pass' &&
		inclusion.status === 'pass' &&
		unchecked.length === 0
	) {
		verdict = 'verified';
		headline = 'Verified in your browser';
		summary =
			'Nothing was taken on trust: the signature, the key, and every hash on the path were recomputed here, on this page, from the material the server sent.';
	} else {
		verdict = 'partial';
		headline = proven.length > 0 ? 'Partly verified' : 'Not verified yet';
		summary = `${
			proven.length > 0
				? `${proven.length} link${proven.length === 1 ? '' : 's'} in the chain ${proven.length === 1 ? 'was' : 'were'} checked here and held. `
				: ''
		}${unchecked.length === 1 ? 'One link' : `${unchecked.length} links`} could not be checked at all — which is not the same as failing, and not the same as passing. Each says which it is below.`;
	}

	return {
		verdict,
		headline,
		summary,
		links,
		fold,
		checkpoint,
		proof,
		build: buildCheck.build,
	};
}
