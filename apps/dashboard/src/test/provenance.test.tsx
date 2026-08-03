// Provenance verification, against fixtures the REAL @facet/trust produced.
//
// WHY THE TRUST PACKAGE IS LOADED AT RUNTIME: the dashboard compiles with `lib: DOM`, under which the
// trust package's own sources do not typecheck (its `crypto.subtle.digest` calls are typed against
// @cloudflare/workers-types). A static import would therefore break `pnpm typecheck` inside a package
// this agent must not edit. Loading it through a computed specifier keeps it out of tsc's program
// while running the genuine code — so these fixtures are signed by a real Ed25519 key and proved
// against a real Merkle Mountain Range, never hand-written.
//
// The point of the cross-checks below: the dashboard verifier (lib/provenanceCrypto.ts) is an
// independent re-derivation, and an independent verifier is only worth having if it is pinned to the
// prover's behaviour. Every fixture, valid and tampered, is checked against BOTH implementations and
// they must return the same verdict.

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProvenanceChain } from '../components/ProvenanceChain.js';
import { ProvenanceMerkle } from '../components/ProvenanceMerkle.js';
import type { InclusionProof, SignedCheckpoint } from '../hooks/transparency.js';
import { type ProvenanceResult, runProvenance } from '../lib/provenance.js';
import { verifyInclusionReceipt } from '../lib/provenanceCrypto.js';

/** Absolute path to a trust module, resolved at runtime so tsc never adds it to the program. */
function trustPath(mod: string): string {
	return new URL(`../../../../packages/trust/src/${mod}.ts`, import.meta.url).pathname;
}

type Receipt = InclusionProof['receipt'];

interface TrustMmr {
	leafHash(x: Uint8Array): Promise<Uint8Array>;
	addLeafHash(nodes: Uint8Array[], f: Uint8Array): Promise<number>;
	mmrRoot(nodes: Uint8Array[]): Promise<Uint8Array>;
	proveInclusion(nodes: Uint8Array[], index: number, count: number): unknown;
}
interface TrustReceipts {
	inclusionToReceipt(p: unknown): Receipt;
	verifyInclusionReceipt(r: Receipt, rootHex: string): Promise<boolean>;
}
interface TrustKeys {
	generateSigningJwk(alg?: string): Promise<{
		privateJwk: Record<string, unknown>;
		publicJwk: Record<string, unknown>;
	}>;
	loadSigningKey(jwkJson: string): Promise<unknown>;
}
interface TrustCheckpoint {
	signCheckpoint(cp: unknown, key: unknown, now: number): Promise<SignedCheckpoint>;
}
interface TrustBytes {
	toHex(b: Uint8Array): string;
}
interface TrustCanon {
	canonicalizeBytes(v: unknown): Uint8Array;
}

let mmr: TrustMmr;
let receipts: TrustReceipts;
let bytes: TrustBytes;
let canon: TrustCanon;

/** One hour of one site, exactly as apps/server/src/lib/transparency.ts commits it. */
const RECORD = {
	site_id: 'site-1',
	hostname: 'example.com',
	bucket_start: 1_760_000_000_000,
	interval: 'hour',
	pageviews: 412,
	events: 37,
	visitors: 251,
};

const REF = {
	hostname: RECORD.hostname,
	bucketStart: RECORD.bucket_start,
	interval: 'hour' as const,
};
const CLAIM = {
	siteId: RECORD.site_id,
	pageviews: RECORD.pageviews,
	visitors: RECORD.visitors,
	events: RECORD.events,
};

interface Fixture {
	checkpoint: SignedCheckpoint;
	publicJwk: Record<string, unknown>;
	proof: InclusionProof;
	root: string;
}

let fixture: Fixture;

/**
 * A real MMR of `leaves` hourly records, with RECORD itself at leaf 4 — enough neighbours to force a
 * multi-step inclusion path and more than one accumulator peak (13 leaves gives peaks at heights
 * 3, 2 and 0). Returns the NODE index of RECORD's leaf, which is not its leaf number: interior nodes
 * take positions too, so hardcoding one silently proves a different record.
 */
async function buildTree(leaves: number): Promise<{ nodes: Uint8Array[]; target: number }> {
	const nodes: Uint8Array[] = [];
	let target = 0;
	for (let i = 0; i < leaves; i++) {
		const record = i === 4 ? RECORD : { ...RECORD, bucket_start: RECORD.bucket_start + i };
		const index = await mmr.addLeafHash(
			nodes,
			await mmr.leafHash(canon.canonicalizeBytes(record)),
		);
		if (i === 4) target = index;
	}
	return { nodes, target };
}

beforeAll(async () => {
	// REALM PLUMBING, not a workaround for the code under test. Vitest's jsdom environment executes
	// every transformed module — the trust package and the `jose` it imports — inside jsdom's vm
	// context, while the ambient `TextEncoder` is Node's and emits Node-realm Uint8Arrays. Those fail
	// `payload instanceof Uint8Array` inside jose, which resolves that constructor in the vm realm, so
	// signing throws before a fixture can be built. Re-wrapping the bytes with the runner realm's own
	// `Uint8Array` puts signer and verifier in one realm. Browsers have exactly one realm and need
	// none of this; nothing here touches what is being verified, only how the fixture is produced.
	const encoder = new TextEncoder();
	globalThis.TextEncoder = class RealmTextEncoder {
		readonly encoding = 'utf-8';
		encode(input = ''): Uint8Array {
			return Uint8Array.from(encoder.encode(input));
		}
		encodeInto(input: string, dest: Uint8Array): TextEncoderEncodeIntoResult {
			return encoder.encodeInto(input, dest);
		}
	} as unknown as typeof TextEncoder;

	mmr = (await import(/* @vite-ignore */ trustPath('mmr'))) as TrustMmr;
	receipts = (await import(/* @vite-ignore */ trustPath('receipt'))) as TrustReceipts;
	bytes = (await import(/* @vite-ignore */ trustPath('bytes'))) as TrustBytes;
	canon = (await import(/* @vite-ignore */ trustPath('canonicalize'))) as TrustCanon;
	const keys = (await import(/* @vite-ignore */ trustPath('keys'))) as TrustKeys;
	const cp = (await import(/* @vite-ignore */ trustPath('checkpoint'))) as TrustCheckpoint;

	const { nodes, target } = await buildTree(13);
	const root = bytes.toHex(await mmr.mmrRoot(nodes));
	const receipt = receipts.inclusionToReceipt(mmr.proveInclusion(nodes, target, nodes.length));

	const { privateJwk, publicJwk } = await keys.generateSigningJwk('EdDSA');
	const key = await keys.loadSigningKey(JSON.stringify(privateJwk));
	const checkpoint = await cp.signCheckpoint(
		{ profile: 'MMR_SHA256', size: nodes.length, root, timestamp: '2026-07-31T12:00:00.000Z' },
		key,
		Date.parse('2026-07-31T12:00:00.000Z'),
	);

	fixture = {
		checkpoint,
		publicJwk,
		root,
		proof: {
			rollup_key: `${RECORD.site_id}|${RECORD.hostname}|${RECORD.bucket_start}|hour`,
			size: nodes.length,
			root,
			receipt,
		},
	};
});

/** Routes the four endpoints the verifier consults; `over` replaces any of them per test. */
function mockFetch(over: Partial<Record<string, () => Response>> = {}): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		const route = Object.keys(over).find((k) => url.includes(k));
		if (route) return (over[route] as () => Response)();
		if (url.includes('/api/transparency/checkpoint')) return json(fixture.checkpoint);
		if (url.includes('/api/transparency/inclusion')) return json(fixture.proof);
		if (url.includes('/.well-known/jwks.json')) return json({ keys: [fixture.publicJwk] });
		if (url.includes('/api/attestation/evidence')) return json({ error: 'x' }, 501);
		return json({ error: 'not_found' }, 404);
	}) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function run(fetchImpl: typeof fetch, opts: { ref?: boolean; claim?: boolean } = {}) {
	return runProvenance({
		apiKey: 'clk_test',
		siteId: RECORD.site_id,
		ref: opts.ref === false ? null : REF,
		claim: opts.claim === false ? null : CLAIM,
		fetchImpl,
	});
}

function linkOf(result: ProvenanceResult, id: string) {
	const link = result.links.find((l) => l.id === id);
	if (!link) throw new Error(`no ${id} link`);
	return link;
}

/** A copy of the fixture receipt with one hex character of `field` flipped. */
function corrupt(receipt: Receipt, field: 'leaf' | 'path0'): Receipt {
	const flip = (h: string): string => `${h[0] === 'a' ? 'b' : 'a'}${h.slice(1)}`;
	if (field === 'leaf') return { ...receipt, leaf: flip(receipt.leaf) };
	const path = [...receipt.path];
	path[0] = flip(path[0] as string);
	return { ...receipt, path };
}

describe('inclusion proof verification', () => {
	it('verifies a genuine proof, and agrees with the trust package', async () => {
		const r = fixture.proof.receipt;
		expect(await verifyInclusionReceipt(r, fixture.root)).toBe(true);
		expect(await receipts.verifyInclusionReceipt(r, fixture.root)).toBe(true);
		expect(r.path.length).toBeGreaterThan(1);
		expect(r.peaks.length).toBeGreaterThan(1);
	});

	it('rejects a TAMPERED leaf — and so does the trust package', async () => {
		const bad = corrupt(fixture.proof.receipt, 'leaf');
		expect(await verifyInclusionReceipt(bad, fixture.root)).toBe(false);
		expect(await receipts.verifyInclusionReceipt(bad, fixture.root)).toBe(false);
	});

	it('rejects a wrong sibling hash — and so does the trust package', async () => {
		const bad = corrupt(fixture.proof.receipt, 'path0');
		expect(await verifyInclusionReceipt(bad, fixture.root)).toBe(false);
		expect(await receipts.verifyInclusionReceipt(bad, fixture.root)).toBe(false);
	});

	it('rejects a proof against a different root', async () => {
		const otherRoot = `${fixture.root.slice(0, -1)}${fixture.root.endsWith('a') ? 'b' : 'a'}`;
		expect(await verifyInclusionReceipt(fixture.proof.receipt, otherRoot)).toBe(false);
	});

	it('rejects an interior node dressed up as a leaf', async () => {
		// Node index 2 is the first aggregation node (height 1). Accepting it would let an internal
		// hash pass as a committed log entry, since the profile gives leaves no domain tag.
		const bad = { ...fixture.proof.receipt, index: 2 };
		expect(await verifyInclusionReceipt(bad, fixture.root)).toBe(false);
		expect(await receipts.verifyInclusionReceipt(bad, fixture.root)).toBe(false);
	});

	it('fails closed on malformed hex rather than throwing', async () => {
		const bad = { ...fixture.proof.receipt, leaf: 'zz' };
		expect(await verifyInclusionReceipt(bad, fixture.root)).toBe(false);
	});
});

describe('the full chain, verified', () => {
	it('passes every link it can check and reports the walk', async () => {
		const result = await run(mockFetch());
		expect(result.verdict).toBe('verified');
		expect(linkOf(result, 'number').status).toBe('pass');
		expect(linkOf(result, 'number').checked).toBe(true);
		expect(linkOf(result, 'signature').status).toBe('pass');
		expect(linkOf(result, 'key').status).toBe('pass');
		expect(linkOf(result, 'inclusion').status).toBe('pass');
		// The attestation endpoint returned 501 — stated as unavailable, never as a pass.
		expect(linkOf(result, 'build').status).toBe('skip');
		expect(linkOf(result, 'build').checked).toBe(false);
		expect(result.fold?.steps.length).toBe(fixture.proof.receipt.path.length);
		expect(result.fold?.matchedPeak).not.toBeNull();
		expect(result.fold?.computedRoot).toBe(fixture.root);
		expect(result.fold?.anchorSigned).toBe(true);
	});

	it('binds the displayed figures to the logged record — a changed number fails', async () => {
		const result = await runProvenance({
			apiKey: 'clk_test',
			siteId: RECORD.site_id,
			ref: REF,
			// One extra pageview on screen: the log is intact, the number is not the logged one.
			claim: { ...CLAIM, pageviews: CLAIM.pageviews + 1 },
			fetchImpl: mockFetch(),
		});
		expect(result.verdict).toBe('failed');
		expect(linkOf(result, 'number').status).toBe('fail');
		// The log itself is still sound; only the binding to the display broke.
		expect(linkOf(result, 'inclusion').status).toBe('pass');
	});

	it('never claims the number when the caller supplied no figures', async () => {
		const result = await run(mockFetch(), { claim: false });
		expect(linkOf(result, 'number').status).toBe('info');
		expect(linkOf(result, 'number').checked).toBe(false);
	});
});

describe('failure modes are distinct and honest', () => {
	it('unsigned deployment: 404 is a configuration, not an error', async () => {
		const result = await run(
			mockFetch({
				'/api/transparency/checkpoint': () => json({ error: 'no_checkpoint' }, 404),
			}),
		);
		expect(result.verdict).toBe('unsigned');
		expect(result.headline).toMatch(/does not sign/i);
		expect(result.summary).toMatch(/Nothing is broken/i);
		// Not one link may claim a pass when there is nothing to check.
		expect(result.links.every((l) => l.status === 'skip' && !l.checked)).toBe(true);
	});

	it('endpoint unreachable: no verdict about the data', async () => {
		const result = await run(
			mockFetch({
				'/api/transparency/checkpoint': () => {
					throw new Error('connection refused');
				},
			}),
		);
		expect(result.verdict).toBe('unavailable');
		expect(result.headline).toMatch(/could not reach/i);
		expect(result.links.some((l) => l.status === 'pass')).toBe(false);
	});

	it('signature invalid: a payload edited after signing', async () => {
		const tampered: SignedCheckpoint = {
			...fixture.checkpoint,
			payload: { ...fixture.checkpoint.payload, size: fixture.checkpoint.payload.size + 1 },
		};
		const result = await run(
			mockFetch({ '/api/transparency/checkpoint': () => json(tampered) }),
		);
		expect(result.verdict).toBe('failed');
		expect(linkOf(result, 'signature').status).toBe('fail');
		expect(linkOf(result, 'signature').checked).toBe(true);
		expect(linkOf(result, 'signature').detail).toMatch(/did not verify/i);
	});

	it('key swapped: kid no longer matches the embedded key', async () => {
		const keys = (await import(/* @vite-ignore */ trustPath('keys'))) as TrustKeys;
		const other = await keys.generateSigningJwk('EdDSA');
		const swapped: SignedCheckpoint = {
			...fixture.checkpoint,
			proof: {
				...fixture.checkpoint.proof,
				publicJwk: other.publicJwk as SignedCheckpoint['proof']['publicJwk'],
			},
		};
		const result = await run(
			mockFetch({ '/api/transparency/checkpoint': () => json(swapped) }),
		);
		expect(linkOf(result, 'signature').status).toBe('fail');
		expect(linkOf(result, 'signature').detail).toMatch(/thumbprint/i);
	});

	it('key not found in JWKS: signature holds, provenance of the key does not', async () => {
		const result = await run(mockFetch({ '/.well-known/jwks.json': () => json({ keys: [] }) }));
		expect(linkOf(result, 'signature').status).toBe('pass');
		expect(linkOf(result, 'key').status).toBe('fail');
		expect(linkOf(result, 'key').detail).toMatch(/NOT in the key set/);
		expect(result.verdict).toBe('failed');
	});

	it('JWKS unreachable: not checked, and not reported as checked', async () => {
		const result = await run(
			mockFetch({
				'/.well-known/jwks.json': () => {
					throw new Error('offline');
				},
			}),
		);
		expect(linkOf(result, 'key').status).toBe('warn');
		expect(linkOf(result, 'key').checked).toBe(false);
		expect(result.verdict).toBe('partial');
	});

	it('inclusion proof fails: the record does not reproduce the signed root', async () => {
		const result = await run(
			mockFetch({
				'/api/transparency/inclusion': () =>
					json({
						...fixture.proof,
						receipt: corrupt(fixture.proof.receipt, 'path0'),
					}),
			}),
		);
		expect(result.verdict).toBe('failed');
		expect(linkOf(result, 'inclusion').status).toBe('fail');
		expect(linkOf(result, 'inclusion').checked).toBe(true);
	});

	it('blames the missing proof, not the caller, when the figures cannot be compared', async () => {
		// Regression: with a proof that could not be fetched, the number link used to say the VIEW had
		// supplied no figures — accusing the wrong party for a state the reader cannot act on.
		const result = await run(
			mockFetch({ '/api/transparency/inclusion': () => json({ error: 'forbidden' }, 403) }),
		);
		expect(linkOf(result, 'number').detail).toMatch(/no inclusion proof was available/);
		expect(linkOf(result, 'number').detail).not.toMatch(/did not hand the proof panel/);
	});

	it('proof not yet anchored: newer tree than the last signed head', async () => {
		// The log grew past the checkpoint: the proof is internally sound but nothing has signed it.
		// Same 13 records, same target leaf, plus one more hour appended after the checkpoint.
		const { nodes, target } = await buildTree(13);
		await mmr.addLeafHash(nodes, await mmr.leafHash(canon.canonicalizeBytes({ extra: true })));
		const newerRoot = bytes.toHex(await mmr.mmrRoot(nodes));
		const receipt = receipts.inclusionToReceipt(
			mmr.proveInclusion(nodes, target, nodes.length),
		);
		const result = await run(
			mockFetch({
				'/api/transparency/inclusion': () =>
					json({ ...fixture.proof, size: nodes.length, root: newerRoot, receipt }),
			}),
		);
		expect(linkOf(result, 'inclusion').status).toBe('warn');
		expect(linkOf(result, 'inclusion').detail).toMatch(/newest SIGNED tree head/);
		expect(result.verdict).toBe('partial');
	});

	it('inclusion forbidden: says the proof is site-scoped, not that the data is bad', async () => {
		const result = await run(
			mockFetch({ '/api/transparency/inclusion': () => json({ error: 'forbidden' }, 403) }),
		);
		expect(linkOf(result, 'record').status).toBe('warn');
		expect(linkOf(result, 'record').detail).toMatch(/scoped to a site/i);
		expect(result.verdict).toBe('partial');
	});

	it('bucket not yet logged: a timing fact, worded as one', async () => {
		const result = await run(
			mockFetch({ '/api/transparency/inclusion': () => json({ error: 'not_logged' }, 404) }),
		);
		expect(linkOf(result, 'record').status).toBe('warn');
		expect(linkOf(result, 'record').detail).toMatch(/not in the log yet/i);
	});

	it('an aggregate metric says so rather than pretending to have a proof', async () => {
		const result = await run(mockFetch(), { ref: false, claim: false });
		expect(linkOf(result, 'inclusion').status).toBe('info');
		expect(linkOf(result, 'inclusion').checked).toBe(false);
		expect(result.fold).toBeNull();
	});
});

describe('the chain UI never shows a tick it did not earn', () => {
	function chain(result: ProvenanceResult): ReactElement {
		return <ProvenanceChain result={result} loading={false} />;
	}

	it('labels a verified link "Verified here" and an unchecked one "Not checked"', async () => {
		render(chain(await run(mockFetch())));
		expect(screen.getAllByText('Verified here').length).toBeGreaterThan(0);
		// The 501 attestation endpoint must read as unavailable, not as a pass.
		expect(screen.getByText('Not available')).toBeInTheDocument();
	});

	it('shows no pass wording at all on an unsigned deployment', async () => {
		const result = await run(
			mockFetch({
				'/api/transparency/checkpoint': () => json({ error: 'no_checkpoint' }, 404),
			}),
		);
		render(chain(result));
		expect(screen.queryByText('Verified here')).toBeNull();
		expect(screen.getByText(/does not sign its data/i)).toBeInTheDocument();
	});

	it('raises an alert, not a status, when a check fails', async () => {
		const result = await run(
			mockFetch({
				'/api/transparency/inclusion': () =>
					json({ ...fixture.proof, receipt: corrupt(fixture.proof.receipt, 'leaf') }),
			}),
		);
		render(chain(result));
		expect(screen.getByRole('alert')).toHaveTextContent(/Verification failed/i);
		expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
	});
});

describe('the Merkle walk', () => {
	it('gives every step a text equivalent and keyboard stepping', async () => {
		const result = await run(mockFetch());
		if (!result.fold) throw new Error('expected a fold');
		render(<ProvenanceMerkle fold={result.fold} failed={false} />);

		// The sr-only table carries one row per fold step plus the leaf, the summit and the root.
		const rows = screen.getAllByRole('row');
		expect(rows.length).toBe(result.fold.steps.length + 4);
		// Every sibling hash is present as text, so the diagram is not the only way to read the proof.
		for (const step of result.fold.steps) {
			expect(screen.getAllByText(step.sibling).length).toBeGreaterThan(0);
		}
		// Stepping is real buttons, one per step, reachable without a pointer.
		expect(
			screen.getByRole('button', {
				name: `Go to step ${result.fold.steps.length + 2} of ${result.fold.steps.length + 2}`,
			}),
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
	});
});
