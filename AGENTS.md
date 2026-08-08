# Repository Guidelines

## Project Structure & Module Organization

Facet is a pnpm workspace organized into `apps/*` and `packages/*`. `apps/server` contains the
Cloudflare Worker, D1 schemas and migrations, while `apps/dashboard` is the React/Vite interface.
Reusable TypeScript lives in `packages/shared`; browser tracking code is in `packages/client`, CLI
commands in `packages/cli`, and provenance primitives in `packages/trust`. Tests are kept in each
workspace's `test/` directory as `*.test.ts`. Documentation and media belong in `docs/` and
`assets/`.

## Build, Test, and Development Commands

Use Node 22 or newer and pnpm 11.

- `pnpm install` installs all workspace dependencies.
- `pnpm dev:web` runs the dashboard with Vite; `pnpm dev:worker` runs the Worker with Wrangler.
- `pnpm build` builds the dashboard and all publishable packages.
- `pnpm typecheck` runs TypeScript checks across every workspace.
- `pnpm test` runs all Vitest suites serially; target one package with
  `pnpm --filter @facet/server test`.
- `pnpm lint` checks the repository with Biome; `pnpm lint:fix` applies safe fixes.

## Coding Style & Naming Conventions

Write strict TypeScript and ESM only. Local imports must include explicit `.js` extensions. Biome
enforces tabs (width 4), 100-character lines, single-quoted JavaScript strings, semicolons, and
organized imports. Use `camelCase` for variables and functions, `PascalCase` for types and React
components, and `CONSTANT_CASE` for constants. Avoid `any`, non-null assertions, unused exports,
and unrelated formatting changes.

## Testing Guidelines

Vitest is the standard framework; Worker tests execute through Cloudflare's workerd pool. Add or
update a focused `*.test.ts` whenever logic changes. Run the affected package first, then
`pnpm test`, `pnpm typecheck`, and `pnpm lint` before submitting. No numeric coverage threshold is
declared, but new behavior and regressions should be exercised directly.

## Commit & Pull Request Guidelines

Follow the history's conventional form: `type(scope): imperative description`, for example
`security(server): reject unsigned callbacks`. Accepted types include `fix`, `feat`, `refactor`,
`test`, `docs`, `perf`, `security`, and `chore`. Keep each commit and PR focused. Complete the PR
template, explain behavioral and privacy impact, link relevant issues, add dashboard screenshots
for UI changes, and ensure lint, typecheck, build, and tests pass.

## Privacy, Security & Schema Changes

Facet is cookieless and privacy-first: never store raw IP addresses, cross-session identifiers, or
new PII fields. Report vulnerabilities through `SECURITY.md`, not public issues. Edit D1 schemas in
`apps/server/src/db/schema.ts`, run `pnpm --filter @facet/server db:generate`, and never hand-edit
generated migration SQL.
