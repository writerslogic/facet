<!-- Standing brief handed to any external reviewer engaged to assess the trust & provenance layer.
     Deliberately impersonal: it should be usable by whoever picks up the review, including a fork's
     own maintainers commissioning their own audit. -->

# Facet — Security Audit Brief

**For:** any external reviewer assessing the Facet trust & provenance layer
**Subject:** Independent review of `packages/trust` and its server integration points
**Status:** Unaudited new cryptographic code. Internally reviewed only (see §7). An independent external assessment is wanted before it ships as a security guarantee.

---

## 1. What Facet is

Facet is a privacy-first, cookieless web analytics service that runs entirely on Cloudflare Workers (workerd) with a D1 (SQLite) backend. The **core analytics product** (event collection, aggregation, dashboard, browser SDK, CLI) is mature and is not the focus of this review.

The focus is the **trust & provenance layer** (`packages/trust`): an opt-in set of cryptographic primitives that let a deployment sign its outputs and prove properties about itself (data-retention attestations, signed stats exports, a transparency log, verifiable credentials, hardware key-attestation). It is **inert unless a signing key is configured**, so a normal deployment never exercises it.

What is wanted is an adversary's read on whether these primitives actually deliver the integrity and authenticity they claim, before they are presented to users as trustworthy.

## 2. Scope

**In scope — `packages/trust/src/`:**

| Area | Files | Standard |
|---|---|---|
| Canonicalization | `canonicalize.ts` | RFC 8785 (JCS) |
| Detached JWS | `jws.ts`, `signed-export.ts` | RFC 7515 |
| HTTP Message Signatures | `http-sig.ts` | RFC 9421 + RFC 9530 |
| Verifiable Credentials | `vc.ts`, `multikey.ts`, `did-web.ts` | W3C VC 2.0 / Data Integrity `eddsa-jcs-2022`, did:web, DIF DID Configuration |
| Selective disclosure | `sd.ts` | SD-JWT-style |
| Transparency log | `mmr.ts`, `checkpoint.ts`, `receipt.ts` | Merkle Mountain Range (draft-bryce COSE-receipts MMR profile) |
| Signed statements / receipts | `scitt.ts`, `statement.ts` | SCITT |
| Remote attestation | `rats.ts`, `keyattest.ts` | RATS EAT, hardware key-attestation |
| COSE | `cose.ts` | RFC 9052 COSE_Sign1 |
| Key + encoding primitives | `keys.ts`, `bytes.ts`, `base58.ts` | Ed25519 / ES256 via Web Crypto + jose |

**Server integration points (in scope for trust-boundary questions):**
`apps/server/src/lib/signing.ts` (key loading), `apps/server/src/lib/transparency.ts` (D1-backed MMR log), `apps/server/src/lib/scitt.ts`, and the `.well-known` / attestation / report routes.

**Out of scope:** the analytics ingestion pipeline, dashboard UI, rate limiting, bot filtering. (Scope can be extended on request.)

## 3. Runtime & cryptographic model

- **Runtime:** Cloudflare Workers (V8 isolate / workerd). All crypto is **Web Crypto (`crypto.subtle`)** plus `jose`; no native modules. This is a deliberate constraint — everything must run in workerd.
- **Algorithms:** Ed25519 (primary) and ECDSA P-256 / SHA-256 (ES256). RFC 9421 uses raw signatures (Ed25519 over the base; ECDSA in IEEE-P1363 r‖s form).
- **Cross-runtime key handling:** private keys are imported via `crypto.subtle.importKey('jwk', …)` rather than jose's `importJWK`, because the latter yields a Node `KeyObject` that `crypto.subtle` cannot use for raw sign/verify. Worth confirming this doesn't introduce a key-handling weakness.
- **Determinism:** Ed25519 signatures are deterministic; several tests rely on this. ES256 is not.

## 4. Trust boundaries & invariants (please try to break these)

1. **Signing key secrecy.** The deployment signing key is the `FACET_SIGNING_JWK` Cloudflare secret. The private key is imported once per isolate and never logged, returned, or written to D1. Only the public key is published (JWKS, did:web). *Verify the private key cannot leak via any signed artifact, error path, or the `.well-known` endpoints.*
2. **No PII in signed artifacts** (hard invariant). Transparency-log leaves commit **aggregate rollup rows** (JCS bytes of site/hostname/bucket/pageviews/visitors counts), never raw events or anything visitor-identifying. Attestations attest a **DEPLOYMENT or DATASET, never a person**. *Verify no code path signs or commits PII.*
3. **Verifier key-pinning.** Verification uses a **caller-supplied** key (JWK, Multikey, or a key resolved from a domain-served DID document) — never a key embedded in the untrusted object being verified. *This is the primary anti-forgery property; verify there is no path where an attacker-signed object selects its own verification key and passes.*
4. **Algorithm binding.** Every raw verify checks that the declared `alg` matches the actual key's algorithm, and the signed bytes include the algorithm (COSE Sig_structure, JWS protected header). *Verify no algorithm-confusion or downgrade.*

## 5. Highest-value verification targets

The verification entry points are where a bug means forgery or bypass:

- `verifyCredential` (`vc.ts`) — eddsa-jcs-2022 proof; recomputes `hashData = SHA-256(JCS(proofConfig)) ‖ SHA-256(JCS(document))`.
- `verifyResponse` (`http-sig.ts`) — RFC 9421; must bind `content-digest` to the body and `alg` to the key.
- `verifyDidConfiguration` (`did-web.ts`) — origin/domain-linkage binding; key comes from the DID document.
- `verifyInclusion` / `verifyConsistency` (`mmr.ts`) — Merkle proofs; must reject interior-node proofs and bind proof peaks to the signed checkpoint root.
- `verifyScittReceipt` / `verifySignedStatement` (`scitt.ts`, `statement.ts`) — receipt-to-statement binding.
- `verifyKeyAttestation` (`keyattest.ts`) — gates `hardware:true` on a caller-supplied **trust-anchor** allowlist by RFC 7638 thumbprint; includes a freshness guard.
- `verifyProcessEvidence` / `verifyPopChallenge` (`rats.ts`) — RATS EAT + proof-of-possession challenge/response.
- `verifyCoseSign` (`cose.ts`), `verifyDetachedProof` / `verifyDetachedJws` (`jws.ts`), `verifySelectiveCredential` disclosure digest binding (`sd.ts`).

**Attack classes most worth testing:** key-substitution / trust-anchor bypass, algorithm confusion, unverified field binding (is every security-relevant field actually inside the signed bytes?), canonicalization collisions or field-position moves, freshness/replay on attestation and PoP, and truncation/boundary issues in base58/base64/hex decoding of attacker input.

## 6. How to build and run

Monorepo (pnpm). From the repo root:

```
pnpm install
pnpm -r typecheck          # all packages
pnpm --filter @facet/trust test   # runs in real workerd
pnpm -r test               # full workspace suite
```

Trust tests live in `packages/trust/test/`. They run under `@cloudflare/vitest-pool-workers`, i.e. against the **real workerd runtime**, not a Node shim — so the crypto you review is the crypto that runs in production.

## 7. What has already been checked (so you can skip or re-verify as you see fit)

- **Standards conformance vectors** exist for RFC 8785 (JCS §3.2.2/§3.2.3, including surrogate-pair key ordering), RFC 9421 (independent signature-base reconstruction), and eddsa-jcs-2022 (independent hashData reconstruction). Each rebuilds the spec's signing input from scratch and asserts byte-identical output.
- **An internal adversarial review** of every verification path (the attack classes in §5) found no exploitable vulnerabilities and confirmed the invariants in §4. It flagged two defense-in-depth gaps — VC `validFrom`/`validUntil` and HTTP-signature freshness were not enforced — which are now closeable via opt-in parameters (`verifyCredential({ now })`, `verifyResponse({ now, maxAgeSeconds })`).

This internal review is **not a substitute for your assessment** — it was performed by the same party that wrote the code. Treat its conclusions as claims to falsify, not as findings to trust.

## 8. What the review should produce

1. An adversarial pass on the §5 verification paths against the §5 attack classes.
2. A judgment on whether the §4 invariants actually hold.
3. Any weakness in key provisioning / secret handling (§4.1).
4. Whether the standards implementations are interoperable and correct enough to claim conformance, or whether those claims should be softened.

Findings in whatever form suits you — file:line + a concrete exploit per issue is ideal. Severity ranking helps prioritize. A "nothing exploitable found" result, with the coverage you actually ran, is equally valuable.

## 9. Process

Let's run it as a loop so nothing gets lost:

1. **Report every suspected vulnerability privately** through the channel in `SECURITY.md`, with
   file:line, a concrete exploit/repro, and a proposed severity. Do not open a public issue before
   coordinated disclosure, even when the initial severity appears low.
2. **The maintainers patch** each private finding and reference its advisory identifier in the fixing
   commit when disclosure timing allows, then ping you when a batch is ready.
3. **You re-review** the patches (mark the private finding unresolved if a fix is incomplete; close
   it if it holds). A sanitized public issue can be created after disclosure if follow-up work is
   useful and no exploit detail remains sensitive.
4. **Official report when everything passes** — once all issues are closed, a short signed-off summary of what you reviewed, what you found, and that the current state passes. That is the document to attach when presenting the trust layer as audited.

Private disclosure channel: see [`SECURITY.md`](../SECURITY.md) — GitHub private security advisories, or the maintainer contact listed there. (Separately, a *running deployment* publishes its **own** operator's contact at `/.well-known/security.txt`, RFC 9116, built by `apps/server/src/lib/security-txt.ts`; that address belongs to whoever runs that instance, not to this project.)
