<!-- Docs index for Facet. Links to each documentation page. -->

# Facet documentation

The dashboard also ships these docs in-app: open the **Documentation** tab for a searchable
version covering setup, credentials, metric definitions, shortcuts and troubleshooting.

- [Usage](./usage.md) — add the script tag, use the `facet` npm API, umami-compatible globals, and custom events with props.
- [Self-hosting](./self-hosting.md) — deploy the Worker + D1 to your own Cloudflare account, create sites and API keys, and run locally.
- [Privacy model](./privacy.md) — cookieless, salted daily-hash unique counting, derived sessions, UTM handling, and retention.
- [Trust & provenance](./trust.md) — what a deployment publishes (signed keys, DID, privacy & build attestations), how to verify it, and hardware-rooted signing keys.
- [Standards & conformance](./standards.md) — every open standard Facet implements (privacy, security, provenance, transparency, supply chain) and where.
- [API reference](./api.md) — the ingest beacon, the API-key stats endpoints (including sessions & engagement, traffic channels, goals, conversions, and funnels), and the admin site/key/goal/funnel/alert endpoints.

Project-level policy lives at the repository root: [licensing](../LICENSING.md) (which license covers
which package, and the commercial option), [trademark & attribution](../TRADEMARK.md) (the name, the
logo, and how to remove "Powered by Facet"), and [security](../SECURITY.md) (reporting a
vulnerability **in Facet itself** — a running deployment publishes its own operator's contact at
`/.well-known/security.txt`). Two further notes are for maintainers rather than adopters: the
[OpenSSF Best Practices evidence map](./openssf-best-practices.md) and the standing
[security audit brief](./security-audit-brief.md) for external reviewers.

## Keeping these honest

Documentation drifts silently: a number or a metric definition is written correctly, the code
changes, and nothing connects the two. `apps/dashboard/src/test/docDrift.test.tsx` runs in CI and
closes that loop. It reads the implementation off disk and pins each mechanically-checkable claim to
the constant or predicate that decides it — the documented limits derive from the real constants,
each metric definition is checked against the SQL that computes it, and every route mounted in
`apps/server/src/routes/registry.ts` must appear in [api.md](./api.md). Changing a constant or a
predicate without updating the prose fails the build, with a message naming the claim and its source
of truth. When you add a checkable claim to the in-app docs or to `api.md`, add its guard there.
