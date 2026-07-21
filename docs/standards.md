<!-- Standards & specifications Facet implements or conforms to, with the module/endpoint that realizes each. -->

# Standards & conformance

Facet is built on open standards rather than bespoke formats. This page maps each standard to where it
is implemented and how to verify it. Trust primitives live in the Workers-native `@facet/trust`
package (proven to run in `workerd`); the standards that cannot run in Workers ship in the Node CLI —
see [Trust & provenance](./trust.md) for the runtime split.

## Privacy & consent

| Standard | What Facet does | Where |
| --- | --- | --- |
| **Global Privacy Control (GPC)** | Honored as an opt-out signal (`navigator.globalPrivacyControl`) | `packages/client` opt-out |
| **Do Not Track** | Honored as an opt-out signal | `packages/client` opt-out |
| **W3C Data Privacy Vocabulary (DPV)** | Machine-readable privacy manifest of processing / purpose / legal basis | `/.well-known/facet-privacy.json` |
| **GDPR / ePrivacy (by construction)** | Cookieless; unique counting via daily-rotating salted `SHA-256`; raw IP never stored | [privacy.md](./privacy.md) |

## Security & disclosure

| Standard | What Facet does | Where |
| --- | --- | --- |
| **RFC 9116 (`security.txt`)** | Machine-readable security contact + policy | `/.well-known/security.txt` |
| **RFC 8615 (well-known URIs)** | All discovery documents under `/.well-known/` | `apps/server` well-known routes |

## Cryptographic provenance & identity

| Standard | What Facet does | Where |
| --- | --- | --- |
| **RFC 7517 / 7518 (JWK/JWKS/JWA)** | Ed25519 + ECDSA P-256 keys, published as a JWKS | `/.well-known/jwks.json` |
| **RFC 7638 (JWK thumbprint)** | Stable, self-describing `kid`; the basis of key-binding | `@facet/trust` keys |
| **RFC 8785 (JCS)** | Canonicalization for all signed payloads | `@facet/trust` canonicalize |
| **RFC 7515 (JWS, incl. detached App. F)** | HTTP-context signatures over canonical bytes | `@facet/trust` jws |
| **RFC 9052 (COSE_Sign1)** | SCITT / COSE-receipts native wire form (EdDSA / ES256) | `@facet/trust` cose |
| **RFC 9421 (HTTP Message Signatures)** | Signed responses (`content-digest` + `content-type`) | `@facet/trust` http-sig |
| **W3C DID + `did:web`** | Deployment identity as `did:web:<host>` | `/.well-known/did.json` |
| **DIF Well-Known DID Configuration** | Proves the DID controls the origin domain | `/.well-known/did-configuration.json` |
| **W3C VC Data Model 2.0 + Data Integrity (`eddsa-jcs-2022`)** | Signed PrivacyAttestationCredential | `/api/attestation/privacy` |
| **W3C `ecdsa-sd-2023` / `bbs-2023`** | Selective-disclosure credentials (Node CLI only) | `facet sd` |

## Transparency & attestation

| Standard | What Facet does | Where |
| --- | --- | --- |
| **IETF SCITT** | Signed Statements + inclusion Receipts; pluggable external service | `/api/scitt/*` |
| **COSE Receipts / MMR** (`draft-bryce-cose-receipts-mmr-profile`) | D1-persisted Merkle Mountain Range log + inclusion/consistency proofs | `/api/transparency/*` |
| **IETF RATS (EAT, RFC 9711)** | Process-evidence attestation + challenge-response proof-of-possession | `/api/attestation/evidence` |
| **RATS key-binding** (`draft-reddy-rats-key-binding`) | `cnf` subject key + `eat_nonce` + verified hardware `key-attributes` | `@facet/trust` rats/keyattest |

## Supply chain

| Standard | What Facet does | Where |
| --- | --- | --- |
| **SLSA v1.0 Build Level 2** | Signed build provenance on every published package | [SECURITY.md](../SECURITY.md), `release.yml` |
| **npm provenance (Sigstore/Rekor)** | `npm publish --provenance` | `release.yml` |
| **SPDX / CycloneDX SBOM** | Software Bill of Materials attached to each release | `release.yml` |

Verify a release's provenance:

```sh
npm audit signatures
gh attestation verify "$(npm pack @writerslogic/facet-cli --silent)" --repo writerslogic/facet
```

See [Trust & provenance](./trust.md) for how a running deployment attests itself, and
[SECURITY.md](../SECURITY.md) for the supply-chain and disclosure policy.
