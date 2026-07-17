# Security Policy

## Supported Versions

Facet is pre-1.0 and under active development. Security fixes are applied to
`main`; there is no long-term support branch yet.

| Version | Supported |
|---------|-----------|
| `main`  | ✅        |
| < 0.3   | ❌        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

### Preferred Method

Open a private advisory via
[GitHub Security Advisories](https://github.com/writerslogic/facet/security/advisories/new),
or email **admin@writerslogic.com**.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (do **not** include real API keys, admin tokens, or `.dev.vars`)
- The affected surface (Worker/API, dashboard, client, or CLI) and version/commit

You can expect an initial response within a few days. Coordinated disclosure is
appreciated; please give us a reasonable window to ship a fix before publishing details.

## Scope & privacy model

Facet is privacy-first by design: unique visitors are counted with a **daily-rotating, salted
`SHA-256` hash**, and **raw IP addresses are never stored, logged, or returned**. Reports that are
especially valuable include:

- Any path by which a raw IP, user-agent, or other PII could be persisted, logged, or exfiltrated
- Any way to recover cross-day visitor identity from stored data (the model guarantees this is
  cryptographically prevented)
- Authentication bypasses on the admin (`ADMIN_TOKEN`) or API-key (`clk_...`) surfaces
- Cross-site data access (a key or token reading another site's data)
- Injection (SQL/JSON) via the collect, event, stats, or admin endpoints

## Handling of secrets

The only secret in a v1 deployment is `ADMIN_TOKEN` (a Worker secret). API keys are stored only as
`SHA-256` hashes; plaintext keys are shown once at issuance and are never retrievable. Never commit
`.dev.vars`, tokens, or database ids in a report or PR.
