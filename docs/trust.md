<!-- Trust & provenance guide: what a Facet deployment publishes, how to verify it, and how to root
     signing keys in hardware. -->

# Trust & provenance

Facet is verifiable. A deployment publishes machine-readable, cryptographically signed statements
about **itself** — its identity, its signing keys, its privacy processing, and its build/config
state — so a third party can check what a Facet instance is and does without trusting the operator's
word. None of these statements ever name a visitor or carry PII; they are claims about the
*deployment*, not about people.

Everything here is built on `@facet/trust`, a Workers-native primitives package that runs unchanged
in `workerd` (real Web Crypto: Ed25519 / ECDSA P-256, JWS, COSE_Sign1, JCS). Standards-heavy formats
that cannot run in Workers (the W3C selective-disclosure cryptosuites, X.509 chain validation) are
shipped in the Node CLI instead — see [the split](#what-runs-where) below.

## What a deployment publishes

All of these are unauthenticated GET endpoints (they describe the public deployment):

| Endpoint | What it is | Standard |
| --- | --- | --- |
| `/.well-known/security.txt` | Security contact + policy | RFC 9116 |
| `/.well-known/jwks.json` | The deployment's signing public key(s) | RFC 7517 / 7638 (`kid` = JWK thumbprint) |
| `/.well-known/did.json` | `did:web:<host>` DID document | W3C DID + Multikey |
| `/.well-known/did-configuration.json` | Domain-linkage proof binding the DID to the origin | DIF Well-Known DID Configuration |
| `/.well-known/facet-privacy.json` | Machine-readable privacy manifest | W3C DPV |
| `/api/attestation/privacy` | Signed **PrivacyAttestationCredential** | W3C VC 2.0 Data Integrity (`eddsa-jcs-2022`) |
| `/api/attestation/evidence` | Signed **RATS process-evidence EAT** (`?nonce=` for freshness) | EAT (RFC 9711) + `draft-condrey` / `draft-reddy` |
| `/api/scitt/register` | Register a Signed Statement with the transparency log | IETF SCITT |
| `/api/transparency/*` | The append-only MMR log + inclusion receipts | `draft-bryce-cose-receipts-mmr-profile` |

The signed endpoints require an Ed25519 signing key (see [Signing configuration](#signing-configuration));
when no key is configured they return `501` / an empty JWKS and the deployment simply runs without
provenance — every analytics feature works regardless.

## Verifying a deployment

1. **Fetch the keys and identity.** `GET /.well-known/jwks.json` and `/.well-known/did.json`. The DID
   is `did:web:<host>`; its verification method resolves to the JWKS key. `/.well-known/did-configuration.json`
   proves the same key controls the origin domain.
2. **Check the privacy claims.** `GET /api/attestation/privacy` returns a VC 2.0 credential with an
   `eddsa-jcs-2022` Data Integrity proof over W3C DPV terms. Verify the proof against the JWKS key; the
   credential references the RATS evidence below.
3. **Check the build/config evidence.** `GET /api/attestation/evidence` returns a RATS EAT whose
   `process-evidence` claim carries the build id, git commit, schema hash, wrangler-config hash, and the
   enabled privacy transforms. Its `content-ref` binds the EAT to the digest of that evidence, and its
   `cnf` claim binds it to the subject key.
4. **Prove freshness (challenge–response).** Pass `?nonce=<random>`; the returned EAT echoes it as
   `eat_nonce`. For full proof-of-possession the issuer also returns a separate PoP signature over the
   nonce made with the `cnf` subject key — a holder without the private key cannot produce it. See
   `answerPopChallenge` / `verifyPopChallenge` in `@facet/trust`.

The CLI runs the same verifiers in Node: `facet verify` checks a signed export/credential offline.

## Signing configuration

Provenance is off until you provision a signing key. Generate one and store the private half as a
Worker secret; the public half is published automatically at `/.well-known/jwks.json`.

```sh
# Generate an Ed25519 signing keypair (prints the private + public JWK)
facet keys generate            # or: node -e "import('@facet/trust').then(t => t.generateSigningJwk().then(k => console.log(JSON.stringify(k))))"

# Store the PRIVATE JWK as a Worker secret
wrangler secret put FACET_SIGNING_JWK
```

See [Self-hosting → Trust & provenance configuration](./self-hosting.md#trust--provenance-configuration)
for every related variable (`SCITT_URL`, `FACET_SECURITY_CONTACT`, the build-metadata vars, etc.).

## Hardware-rooted signing keys

`key-attributes.hardware` in the RATS EAT is a **verified, conditional** claim — never a hardcoded
boolean. It becomes `true` only when a key-attestation, verified against a **configured trust anchor**
and bound to the subject key, proves the private key is hardware-resident and non-extractable.

To earn `hardware: true`:

1. **Hold the signing key in hardware** — a cloud KMS with HSM protection (GCP Cloud KMS HSM, AWS
   KMS/CloudHSM, Azure Managed HSM) or a hardware token (YubiKey / PIV / PKCS#11). Sign via the
   module's API so the private key never enters the Worker isolate.
2. **Supply the module's key-attestation**, in one of two forms:
   - **Native credential** (verified in `workerd`): a `SignedStatement` from the attestor, checked with
     `verifyKeyAttestation` against your configured attestor **trust anchors**.
   - **X.509 attestation chain** (the form real HSMs / YubiKeys / TPMs emit): verified by the Node CLI,
     `facet keyattest verify <leaf.pem> --root <root.pem> --key <deployment-pub>`, using
     `node:crypto`'s battle-tested certificate-path validation. `hardware` requires **both** the chain
     reaching the configured root **and** the leaf's public key equalling the deployment signing key.

Without a trust-anchor-verified attestation, the deployment is honest **software attestation**:
`hardware: false`, `hardwareRootOfTrust: false`. The built-in `/api/attestation/evidence` endpoint
signs with the `FACET_SIGNING_JWK` Worker secret (a software key) and therefore reports software
attestation by default; hardware rooting is a deployment choice that requires KMS/token-backed signing
as above.

### The one boundary we do not fake

Cloudflare does **not** expose an isolate runtime / measured-boot self-quote to Worker code. So Facet
**cannot** attest a measured boot chain of the running isolate *itself* — and it does not pretend to.
That gap is covered from the other side by **build-time provenance**: the release is published with npm
provenance + a GitHub SLSA build-provenance attestation (Sigstore-signed via OIDC), and the EAT's
`process-evidence` carries a signed hash of the deployed config/schema. So *what code and config are
deployed* is provable via the supply chain; only the live-isolate self-quote is unavailable, and that
is a Cloudflare platform limitation, distinct from — and not to be conflated with — hardware rooting of
the signing **key**, which is supported above.

## Transparency (SCITT)

Facet runs a local append-only transparency log — a Merkle Mountain Range profiled against
`draft-bryce-cose-receipts-mmr-profile`, persisted in D1 — and issues real signed inclusion receipts
(`/api/transparency/*`). Signed Statements can be registered locally (`/api/scitt/register`) or
forwarded to an external SCITT Transparency Service by setting `SCITT_URL`; returned receipts are
verified (signature + inclusion proof), not trusted blindly. Operating a *public* production SCITT
service is an integration concern, not a service Facet hosts for you.

## What runs where

Some standards cannot run in Cloudflare Workers; those ship in the Node CLI instead. Nothing is
faked — each path is tested in the runtime where it actually executes.

| Capability | Worker (`workerd`) | Node CLI |
| --- | --- | --- |
| Keys / JWKS, JWS, HTTP Message Signatures (RFC 9421), JCS | ✅ | ✅ |
| COSE_Sign1 (RFC 9052, SCITT / COSE-receipts wire form) | ✅ | ✅ |
| VC 2.0 Data Integrity `eddsa-jcs-2022`, did:web, MMR | ✅ | ✅ |
| RATS EAT + challenge-response PoP | ✅ | ✅ |
| Hardware key-attestation — native credential | ✅ | ✅ |
| Hardware key-attestation — **X.509 chain** | — | ✅ (`facet keyattest`) |
| Selective disclosure — Workers-native (SD-JWT-style over `eddsa-jcs-2022`) | ✅ | ✅ |
| Selective disclosure — **W3C `ecdsa-sd-2023` / `bbs-2023`** | — | ✅ (`facet sd`) |

The W3C selective-disclosure cryptosuites need RDF Dataset Canonicalization (`jsonld` + `rdf-canonize`)
and, for BBS, BLS12-381 pairing crypto. `jsonld` does not load under `workerd` (verified:
`No such module "node:https"`), so those suites are Node-CLI-only; inside the Worker, use the
Workers-native selective disclosure. `@facet/trust` deliberately takes no dependency on them, so its
"runs in workerd" guarantee holds.

## Developer reference

For the primitive-level API (every function, the trust-anchor gate, the wire formats) and the
runtime-verification gate, see [`packages/trust/README.md`](../packages/trust/README.md).
