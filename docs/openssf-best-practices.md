<!-- Evidence map for the OpenSSF Best Practices Badge (bestpractices.dev). The badge is earned; the
     answers themselves live in .bestpractices.json at the repo root, which the badge site reads to
     pre-fill proposals. Keep BOTH in sync as the project evolves. -->

# OpenSSF Best Practices — evidence map

Facet holds the [OpenSSF Best Practices Badge](https://www.bestpractices.dev/projects/14244) at the
**passing** level (100%). This page maps the passing criteria to the evidence behind them.

The answers are not filled in by hand: `.bestpractices.json` at the repo root carries all 67
criteria with their status and justification, and the badge site reads it to pre-fill proposals.
**Change that file, not the web form** — then press "Save (and continue) 🤖" on the project page to
re-run the automation.

| Criterion | Status | Evidence |
| --- | --- | --- |
| Project homepage + describes what it does | ✅ | `README.md`, https://github.com/writerslogic/facet |
| FLOSS license (OSI-approved) | ✅ | `LICENSE` (AGPL-3.0-only) — per-package split in `LICENSING.md` (MIT client/CLI/shared, Apache-2.0 trust) |
| License in standard location | ✅ | `LICENSE` at repo root; each package carries its own `LICENSE` |
| Basic documentation for users | ✅ | `docs/` (usage, self-hosting, api, privacy, trust, standards) |
| Documentation for the interface/API | ✅ | `docs/api.md` |
| Public version-controlled source | ✅ | GitHub, git |
| Unique, semantic version numbering | ✅ | SemVer; `CHANGELOG.md`, git tags `vX.Y.Z` |
| Release notes for each release | ✅ | `CHANGELOG.md` (Keep a Changelog) + GitHub Releases |
| Bug-reporting process | ✅ | GitHub Issues; `CONTRIBUTING.md` |
| Vulnerability-reporting process (private) | ✅ | `SECURITY.md` — GitHub private security advisories, plus the maintainer contact listed there |
| Working build system | ✅ | pnpm workspaces; `pnpm build` |
| Automated test suite | ✅ | Vitest (`@cloudflare/vitest-pool-workers`); the full suite runs on every PR via `pnpm test` in `ci.yml` |
| Tests added with new functionality (policy) | ✅ | Enforced in review; every feature/fix ships regression tests |
| Compiler/linter warning flags | ✅ | `tsc` strict typecheck + Biome lint in CI (`ci.yml`) |
| Secure development knowledge (crypto) | ✅ | Standards-based crypto via Web Crypto + `jose`; see `docs/trust.md`, `docs/standards.md` |
| Uses standard crypto (no bespoke) | ✅ | Ed25519 / ECDSA P-256, SHA-256, JWS/COSE, RFC 8785 — `@facet/trust` |
| Delivered over HTTPS | ✅ | Cloudflare Workers (TLS); npm/registry over HTTPS |
| No leaked credentials | ✅ | Secrets are Worker secrets; API keys stored as SHA-256 hashes; `.dev.vars` gitignored |
| Static analysis | ✅ | CodeQL via GitHub default setup (`extended` query suite, JS/TS + Actions) + Biome lint |
| Dynamic analysis / dependency review | ✅ | Dependency Review (`dependency-review.yml`), Dependabot |
| Supply-chain provenance | ✅ | npm provenance + SLSA build provenance + SBOM (`release.yml`); `SECURITY.md` |
| Automated supply-chain scoring | ✅ | OpenSSF Scorecard (`scorecard.yml`) |

**Status:** 100% at passing level. Two criteria are honestly marked Unmet — `dynamic_analysis` and
`dynamic_analysis_enable_assertions` — because there is no fuzzer or DAST. Both are SUGGESTED rather
than required, so neither blocks the badge, and both track the same gap as Scorecard's `FuzzingID`.

Reaching **silver/gold** additionally wants: signed releases (met — Sigstore provenance), a documented
security-review, and ≥2 maintainers/bus-factor — track those as the project grows.
