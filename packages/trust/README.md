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
- **Selective disclosure (Workers-native)** — an SD-JWT-style mechanism (salted-hash `_sd` digests over
  claims, signed with `eddsa-jcs-2022`), with holder-side selective reveal and verifier re-check of each
  disclosed digest against the signed `_sd` set.
- **MMR** (Merkle Mountain Range) profiled against `draft-bryce-cose-receipts-mmr-profile`
  (`MMR_SHA256`): inclusion + consistency proofs, bagged-root **signed checkpoints**.
- **COSE_Sign1** (RFC 9052) over Web Crypto (EdDSA `-8` / ES256 `-7`), CBOR via **`cborg`** (pure ESM,
  workerd-verified). Protected header carries `alg`+`kid`; signs the real `Sig_structure`; sign→verify,
  tamper→fail, and a pinned deterministic-EdDSA known-answer vector all run in the workers pool. This is
  the **SCITT / COSE-receipts native wire form**, a first-class alternative to JWS for signed statements,
  checkpoints, and SCITT receipts (`signStatementCose` / `signCheckpointCose` / `signSignedStatementCose`
  / `signScittReceipt(…, 'cose')`; `verifyStatement` dispatches on proof type).
- **SCITT** Signed Statements + Receipts (JWS **and** COSE_Sign1); **RATS** process-evidence EAT
  (`draft-condrey-rats-process-evidence-claims` + `draft-reddy-rats-key-binding`) with a real
  **challenge-response proof-of-possession** (`answerPopChallenge` / `verifyPopChallenge`).
- **Hardware key-attestation** — a trusted **attestor** asserts (in a `SignedStatement`, using the same
  COSE_Sign1 / detached-JWS primitives) that a subject key, identified by its RFC 7638 JWK thumbprint,
  is hardware-resident and non-extractable (`signKeyAttestation` / `verifyKeyAttestation`). The RATS EAT
  derives `key-attributes.hardware` (and a new `AttestationResult.hardwareRootOfTrust` /
  `PopVerification.hardwareRootOfTrust`) from a **verified** attestation, never a hardcoded boolean —
  see the trust-anchor gate below. Sign→verify, tamper→fail, wrong-anchor / no-anchor / thumbprint-
  mismatch → `hardware:false`, and the "unreachable without a trust anchor" invariant all run in the
  workers pool (`test/keyattest.test.ts`).

### The trust-anchor gate (security-critical)

`verifyKeyAttestation(att, { trustAnchors, expectedThumbprint })` returns `hardware: true` **only
when all** of these hold, and every early return yields `hardware: false` with a reason:

1. the attestor signature over the statement verifies (`verifyStatement`);
2. the attested `subjectThumbprint` equals the RFC 7638 thumbprint of the echoed subject JWK (the
   attestation cannot lie about which key it is for);
3. if `expectedThumbprint` is supplied, it equals the attested subject thumbprint;
4. the **signer** (the proof's embedded public JWK) is one of the configured `trustAnchors`, matched by
   RFC 7638 thumbprint. An **empty or absent anchor set can never match**, so `hardware` stays false.

There is **no code path** that yields `hardware: true` (or `hardwareRootOfTrust: true`) without a
trust-anchor-verified attestation bound to the subject key. Issue time is gated too: `signProcessEvidence`
sets `hardware: true` and embeds the attestation reference **only** if the supplied attestation verifies
against the supplied `keyAttestationAnchors`; verify time re-checks the embedded attestation against the
verifier's own `trustAnchors` (a verifier that configures no anchor does **not** trust the issuer's claim).

## Hardware key-attestation — workerd-native credential vs Node-CLI X.509

Two forms are supported, split by what runs where:

- **workerd-native credential** (`@facet/trust`, above): the attestation is a `SignedStatement` verified
  with the COSE_Sign1 / detached-JWS primitives that already run in workerd.
- **X.509 attestation chain** (Node CLI, `facet keyattest verify`): the form real HSMs / cloud-KMS-HSMs /
  YubiKeys / TPMs actually emit. The CLI verifies it with **`node:crypto` `X509Certificate`** (battle-
  tested path validation, not a hand-rolled ASN.1 parser): it builds leaf → intermediates → the
  configured PEM **root**, checks each `checkIssued` + `verify(issuer.publicKey)` link and validity at
  `--now`, requires the root to be self-signed, and confirms the **leaf SPKI equals the deployment
  signing key**. hardware requires **both** the chain reaching the configured root **and** the SPKI
  match — the CLI-side analog of the trust-anchor gate. Tests use **static committed PEM fixtures**
  (`packages/cli/test/fixtures/keyattest/`, generated once with openssl); valid chain + SPKI match → 0,
  wrong root / leaf-from-another-CA / SPKI mismatch / expired-at-`--now` → 1.

**Deployment note.** To get `hardware:true`, hold the signing key in an HSM / cloud-KMS-HSM (GCP Cloud
KMS HSM, AWS KMS/CloudHSM, Azure Managed HSM) or a hardware token (YubiKey/PIV/PKCS#11) and sign via the
module's API so the private key never enters the Worker isolate. Supply the module's key-attestation
credential — the workerd-native `SignedStatement` (verified against a configured attestor trust anchor),
or the X.509 attestation chain + root PEM to `facet keyattest verify`. Without a trust-anchor-verified
attestation the EAT is honest software attestation: `hardware:false`, `hardwareRootOfTrust:false`.

## W3C selective-disclosure cryptosuites — Node CLI only (shipped, not in the Worker)

`ecdsa-sd-2023` and `bbs-2023` are **implemented and tested**, but in the **Node CLI**
(`@writerslogic/facet-cli`, `facet sd`), not in the Worker. They need RDF Dataset Canonicalization
(RDFC-1.0 via `jsonld` + `rdf-canonize`) and, for BBS, BLS12-381 pairing crypto. `jsonld` does **not
load under workerd** — verified spike: `No such module "node:https"` (its document loader hard-requires
`node:https`). So these cannot run in Cloudflare Workers. The CLI wraps the digitalbazaar reference
suites with a static, no-network document loader; real issue → deriveProof (selective reveal) → verify,
plus tamper→fail and wrong-key→fail, are covered for both suites. `@facet/trust` deliberately does
**not** depend on them, so its "runs in workerd" guarantee holds. Inside the Worker, use the
Workers-native selective disclosure above.

## Runtime notes (honest scope, not gaps)

- **Hardware rooting of the signing/subject KEY — supported and verified** (see the key-attestation
  section above), not hardcoded. Hold the key in an HSM/KMS-HSM or hardware token, sign via its API, and
  supply the module's key-attestation credential (workerd-native `SignedStatement`) or X.509 chain (Node
  CLI); `key-attributes.hardware` / `hardwareRootOfTrust` become `true` **only** when that attestation
  verifies against a **configured trust anchor** and binds to the subject key. Absent/unverified ⇒ honest
  software attestation (`hardware:false`). Proof-of-possession of the subject key is also implemented:
  the verifier issues a nonce, the issuer returns an EAT carrying `eat_nonce` plus a separate PoP
  signature over the nonce made with the `cnf` subject key, and the verifier checks both the EAT
  signature and the PoP signature against the `cnf` key (`answerPopChallenge` / `verifyPopChallenge`).
- **Isolate runtime self-quote — the one true residual boundary.** Cloudflare does **not** expose an
  isolate runtime / measured-boot self-quote to Worker code, so the EAT cannot attest a measured boot
  chain of the isolate **itself** (distinct from — and not to be conflated with — hardware rooting of the
  KEY above). That boundary is covered from the other side by build-time **SLSA provenance** + a signed
  config/schema hash (the `process-evidence` claim); we do **not** fabricate an isolate quote.
- **Transparency Service** — the MMR log + local SCITT double run *inside* Facet (MMR persisted in D1,
  real signed inclusion receipts); the external `SCITT_URL` client now **verifies** a returned
  Facet-form receipt's signature + inclusion proof. Operating a *public* production SCITT Transparency
  Service is still a deployment/integration concern, not a shipped Facet service.

## Cross-runtime note

The private signing key is imported via `crypto.subtle.importKey('jwk', …)` so it is a real Web Crypto
`CryptoKey` in **both** workerd and Node (jose's `importJWK` yields a Node `KeyObject` that
`crypto.subtle` can't use for the raw RFC 9421 / Data Integrity signing paths). The CLI runs the same
verifiers in Node.
