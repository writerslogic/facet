# @facet/trust

Workers-native trust & provenance primitives for Facet, shared by `@facet/server` and the CLI.
Everything here is proven to run under `@cloudflare/vitest-pool-workers` (real workerd) — see
`test/runtime.test.ts`, which is the gate: if a primitive can't run in workerd, its tests fail.

## What's implemented (and tested in workerd)

- **Keys / JWKS** — Ed25519 (preferred) + ECDSA P-256 via Web Crypto, RFC 7638 thumbprint `kid`.
- **Detached JWS** (RFC 7515 App. F) and **HTTP Message Signatures** (RFC 9421, `ed25519` /
  `ecdsa-p256-sha256` over `content-digest`+`content-type`).
- **JCS** (RFC 8785) canonicalization; **signed-export** envelopes.
- **VC 2.0 Data Integrity**, cryptosuite **`eddsa-jcs-2022`** (Ed25519), with **Multikey** verification
  methods; **did:web** documents + **DIF Well-Known DID Configuration**.
- **Selective disclosure** — an SD-JWT-style, Workers-native mechanism (salted-hash `_sd` digests over
  claims, signed with `eddsa-jcs-2022`).
- **MMR** (Merkle Mountain Range) profiled against `draft-bryce-cose-receipts-mmr-profile`
  (`MMR_SHA256`): inclusion + consistency proofs, bagged-root **signed checkpoints**.
- **COSE_Sign1** (RFC 9052) — the SCITT-native wire format, CBOR via `cborg` (proven in workerd),
  raw Web Crypto signatures, with a pinned known-answer vector.
- **SCITT** Signed Statements + Receipts; **RATS** process-evidence EAT
  (`draft-condrey-rats-process-evidence-claims` + `draft-reddy-rats-key-binding`).

## Runtime gaps (deliberately NOT claimed as shipped)

These are documented format/verification decisions, not oversights:

- **`ecdsa-sd-2023` selective disclosure** — depends on RDF Dataset Canonicalization
  (`jsonld`/`rdf-canonize`), which does not run under workerd. We ship the SD-JWT-style mechanism
  instead. `ecdsa-sd-2023` is **not usable in Cloudflare Workers**.
- **`bbs-2023` selective disclosure** — needs pairing-friendly-curve (BLS12-381) crypto that Web
  Crypto does not provide. **BBS is unavailable in Workers.**
- **Hardware RATS root of trust** — the RATS EAT is **software attestation only**: the signing key is a
  Worker secret, not a hardware-backed Attestation Key, and there is no measured-boot chain.
  Proof-of-possession of the subject key is protocol-level and out of scope.
- **Operating a Transparency Service** — the MMR log + local SCITT double run *inside* Facet, but
  operating a production SCITT Transparency Service is a deployment/integration concern, not a shipped
  Facet service. An external service is pluggable via `SCITT_URL`.

## Cross-runtime note

The private signing key is imported via `crypto.subtle.importKey('jwk', …)` so it is a real Web Crypto
`CryptoKey` in **both** workerd and Node (jose's `importJWK` yields a Node `KeyObject` that
`crypto.subtle` can't use for the raw RFC 9421 / Data Integrity signing paths). The CLI runs the same
verifiers in Node.
