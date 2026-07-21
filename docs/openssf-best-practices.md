<!-- Evidence map for the OpenSSF Best Practices Badge (bestpractices.dev). Register the project there,
     then use this to answer the criteria. Keep in sync as the project evolves. -->

# OpenSSF Best Practices — evidence map

To earn the [OpenSSF Best Practices Badge](https://www.bestpractices.dev), a maintainer must register
the project (requires a GitHub login) and self-attest against the criteria. This page maps the
**passing**-level criteria to evidence already in this repo so the form can be filled quickly.

| Criterion | Status | Evidence |
| --- | --- | --- |
| Project homepage + describes what it does | ✅ | `README.md`, https://github.com/writerslogic/facet |
| FLOSS license (OSI-approved) | ✅ | `LICENSE` (Apache-2.0) |
| License in standard location | ✅ | `LICENSE` at repo root |
| Basic documentation for users | ✅ | `docs/` (usage, self-hosting, api, privacy, trust, standards) |
| Documentation for the interface/API | ✅ | `docs/api.md` |
| Public version-controlled source | ✅ | GitHub, git |
| Unique, semantic version numbering | ✅ | SemVer; `CHANGELOG.md`, git tags `vX.Y.Z` |
| Release notes for each release | ✅ | `CHANGELOG.md` (Keep a Changelog) + GitHub Releases |
| Bug-reporting process | ✅ | GitHub Issues; `CONTRIBUTING.md` |
| Vulnerability-reporting process (private) | ✅ | `SECURITY.md` (private advisories + admin@writerslogic.com) |
| Working build system | ✅ | pnpm workspaces; `pnpm build` |
| Automated test suite | ✅ | Vitest (`@cloudflare/vitest-pool-workers`), 500+ tests; `pnpm test` in CI |
| Tests added with new functionality (policy) | ✅ | Enforced in review; every feature/fix ships regression tests |
| Compiler/linter warning flags | ✅ | `tsc` strict typecheck + Biome lint in CI (`ci.yml`) |
| Secure development knowledge (crypto) | ✅ | Standards-based crypto via Web Crypto + `jose`; see `docs/trust.md`, `docs/standards.md` |
| Uses standard crypto (no bespoke) | ✅ | Ed25519 / ECDSA P-256, SHA-256, JWS/COSE, RFC 8785 — `@facet/trust` |
| Delivered over HTTPS | ✅ | Cloudflare Workers (TLS); npm/registry over HTTPS |
| No leaked credentials | ✅ | Secrets are Worker secrets; API keys stored as SHA-256 hashes; `.dev.vars` gitignored |
| Static analysis | ✅ | CodeQL (`codeql.yml`) + Biome |
| Dynamic analysis / dependency review | ✅ | Dependency Review (`dependency-review.yml`), Dependabot |
| Supply-chain provenance | ✅ | npm provenance + SLSA build provenance + SBOM (`release.yml`); `SECURITY.md` |
| Automated supply-chain scoring | ✅ | OpenSSF Scorecard (`scorecard.yml`) |

**To do (maintainer action):** register at bestpractices.dev, link this repo, and set the two project
URLs. Most passing criteria above map directly; the only manual items are the project-site fields and
confirming the change-control / reporting text.

Reaching **silver/gold** additionally wants: signed releases (met — Sigstore provenance), a documented
security-review, and ≥2 maintainers/bus-factor — track those as the project grows.
