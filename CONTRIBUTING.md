# Contributing to Facet

Thanks for your interest in improving Facet. This document describes how to report issues, set up a
development environment, and submit changes.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you are
expected to uphold it.

## The one rule that shapes everything

Facet is **strictly privacy-first and cookieless**: no cross-session identity, no cookies, and
**raw IP addresses are never stored**. The D1 schema is closed — do not add PII columns
(`raw_ip`, `browser_version`, `utm_*` beyond the declared set, `*_at` audit columns, etc.). A change
that would require persisting identifiable data will not be accepted; propose a privacy-preserving
(aggregate, differential, or client-side) alternative instead.

## How to Contribute

### Reporting Issues

- Use the [issue templates](.github/ISSUE_TEMPLATE) for bugs and feature requests.
- For security vulnerabilities, follow [SECURITY.md](SECURITY.md) — **do not** open a public issue.

### Development setup

Prerequisites: **Node ≥ 20**, **pnpm 11**, and (for deploy/D1) a Cloudflare account with `wrangler`.

```sh
pnpm install
pnpm typecheck   # tsc across every package
pnpm lint        # Biome
pnpm test        # Vitest (server tests run in real workerd via @cloudflare/vitest-pool-workers)
pnpm build       # dashboard + client + CLI artifacts
```

Run a specific package with a filter, e.g. `pnpm --filter @facet/server test`.

### Conventions

- **TypeScript, ESM only.** Import local files with explicit `.js` extensions. `strict` +
  `noUncheckedIndexedAccess` + `verbatimModuleSyntax`.
- **Formatting/lint:** Biome — **tab indentation, width 4, line width 100, single quotes**. Run
  `pnpm exec biome check --write .` before committing. Do not reformat to spaces.
- **Every change that adds logic adds/updates a colocated `*.test.ts`.** Keep the suite green.
- **Schema is generated:** edit `apps/server/src/db/schema.ts`, then
  `pnpm --filter @facet/server db:generate` — never hand-edit migration SQL.

### Commits

`<type>: <description>` — single line, imperative, no em-dashes.
`type ∈ fix | feat | refactor | test | docs | perf | security | chore`. One logical unit per commit.

### Pull requests

- Branch off `main`; keep PRs focused.
- Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md), including the privacy checks.
- CI (lint, typecheck, build, test) must pass.

## Definition of Done

`pnpm lint` = 0, `pnpm typecheck` = 0, `pnpm test` = 0, `pnpm build` succeeds, docs/CHANGELOG updated
when behavior or API changed, and no cross-session identity / raw-IP storage introduced.
