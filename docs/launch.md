# Launch copy (ready to post)

Drafts for the one-shot launch. **Sequence:** land the funnel first (working one-click deploy, live
demo, README hero) — then post. You get one clean Show HN; don't spend it on a rough first-run.
Post Show HN in the morning US-Eastern on a weekday; reply to early comments fast.

Links: repo `https://github.com/writerslogic/facet` · demo `https://writerslogic.github.io/facet/`

---

## Show HN

**Title** (≤ 80 chars, no emoji, "Show HN:" prefix):

> Show HN: Facet – private-by-math web analytics that runs on your Cloudflare edge

**Body** (first comment, from you as the author):

> I built Facet because every "privacy-friendly" analytics tool asks you to *trust* that it doesn't
> track — the privacy is a policy, not a property. Facet tries to make it a property:
>
> - **Private by construction.** Visitors are counted with a daily-rotating salted SHA-256 hash; the
>   raw IP is never stored, and there's no cross-session identity to leak. Segment breakdowns enforce
>   a k-anonymity floor, so a filter can't resolve down to one person — the tool *can't* re-identify,
>   rather than promising it won't.
> - **Runs on your own Cloudflare account.** One Worker is the whole backend — ingest, stats API,
>   dashboard, cron rollups — on Workers + D1. No server, no database to run, free tier is plenty.
> - **Drop-in for Umami.** It's script-tag compatible, so existing sites migrate by repointing one tag.
> - **Verifiable.** A deployment can publish signed statements about itself + a transparency log, so
>   your numbers and your privacy claims are auditable, not just asserted.
> - **Multi-touch attribution without cross-session IDs** (aggregate Markov/heuristic over day-scoped
>   channel paths), revenue reporting, funnels, retention, experiments, and a natural-language "Ask" tab.
>
> AGPL-3.0, self-host free. Live demo (no login): https://writerslogic.github.io/facet/ — repo:
> https://github.com/writerslogic/facet . Happy to answer anything about the privacy model or the
> edge architecture.

---

## r/selfhosted

**Title:** Facet — self-hosted, cookieless analytics that runs entirely on Cloudflare Workers + D1 (one-click, no database)

**Body:**

> I wanted Plausible/Umami-style analytics but with *no server and no database to babysit* — so Facet
> runs 100% on Cloudflare Workers + D1. One Worker does ingest + the stats API + the dashboard + cron
> rollups; state lives in D1; the free tier covers a lot.
>
> Privacy is built-in, not bolted on: daily-rotating salted-hash visitors (raw IP never stored, no
> cookies, no cross-session identity), and segment breakdowns are k-anonymised so you can't drill to a
> single visitor. It's a drop-in for Umami (repoint the script tag). Goals, funnels, retention,
> experiments, revenue, multi-touch attribution, realtime, and CSV/JSON export are all in.
>
> AGPL-3.0. One-click deploy to your own Cloudflare account, live demo, and repo in the comments.
> Feedback welcome — especially on the self-hosting flow.

---

## r/privacy

**Title:** Analytics that *can't* re-identify a visitor — cookieless, k-anonymised, self-hosted (Facet)

**Body:**

> Most "privacy" analytics ask you to trust a policy. Facet is designed so re-identification is
> structurally hard: visitors are a daily-rotating salted SHA-256 hash (raw IP never stored, rotates at
> UTC midnight so cross-day linkage is broken), there are no cookies and no cross-session identity, and
> every segment breakdown enforces a k-anonymity floor — a filter combination can never resolve to one
> person. It also honors GPC/DNT, and a deployment can publish signed, auditable statements about how it
> processes data. Self-hosted (AGPL), runs on your own Cloudflare edge. Demo + repo in comments.

---

## Lobsters

**Title:** Facet: private-by-construction web analytics on Cloudflare Workers + D1

**Tags:** `privacy`, `javascript`, `web`

**Body:** (short — Lobsters prefers terse)

> Cookieless, self-hosted analytics that runs as a single Cloudflare Worker (ingest + stats API +
> dashboard + cron) over D1 — no server, no external DB. Daily-salted-hash visitors (no raw IP, no
> cross-session id), k-anonymised segment breakdowns, Umami-compatible script tag, and optional signed
> provenance so the deployment's privacy claims are auditable. AGPL-3.0.

---

## Cloudflare community / "Built with Workers"

Angle: Facet is a real-world, non-trivial app that uses Workers + D1 + Queues + cron + Workers AI
end-to-end — a good showcase/tutorial candidate ("build a privacy analytics platform on the edge").
Submit to the Built-with-Workers showcase and share in the Cloudflare Developers Discord #built-with.

---

## Indie Hackers / dev.to

Longer-form "why I built it" post: the thesis (privacy as a *property*, not a policy), the edge-native
architecture (one Worker, no DB), and the k-anonymity design. Link the demo + repo. Cross-post to dev.to.
