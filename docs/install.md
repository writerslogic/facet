<!-- Install guide: the one-command installer. -->

# Install

```sh
git clone https://github.com/writerslogic/facet.git
cd facet && pnpm install
npx @writerslogic/facet-cli init
```

That is the whole install. `pnpm install` first creates the gitignored deployment config from the
tracked template without overwriting an existing one. `facet init` creates the D1 database, writes its id into the Worker
config, generates and stores the admin token, applies the migrations, builds the dashboard, deploys
the Worker, then creates your first site and issues its API key — and prints the dashboard URL with
the credentials ready to paste.

It is safe to run again. If it stops at step 7 of 10, run it again and it resumes: existing
resources are detected and reused, never duplicated.

The rest of this page writes it as `facet init`. Three ways to get that command, all equivalent:

```sh
npx @writerslogic/facet-cli init                  # no install, from the checkout
pnpm --filter @writerslogic/facet-cli dev init    # from the checkout, no npm download
npm i -g @writerslogic/facet-cli && facet init    # installed once, then just `facet`
```

## Before you start

| | |
| --- | --- |
| **Node.js ≥ 22** | pnpm 11 requires ≥ 22.13 |
| **pnpm 11** | `corepack enable` installs the pinned version |
| **A Cloudflare account** | the free plan is enough |
| **`wrangler login`** | the installer refuses to guess at credentials |

`wrangler` itself comes with `pnpm install` — you do not need a global one. On a headless machine,
export `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit + D1 Edit) instead of logging in.

## What it asks

Three questions, each with a default you accept by pressing Enter:

1. **Hostname to serve Facet on** — blank uses the free `*.workers.dev` URL. Give your own hostname
   only if the zone is already on your Cloudflare account; Cloudflare provisions the DNS record and
   certificate for you.
2. **Domain of the site you want to track** — a label on the site record, e.g. `example.com`.
3. **Name for that site** — defaults to the domain's first label.

Then it shows the plan (account, resources, hostname) and asks once before doing anything.

Everything else it works out: which wrangler to use and whether it is new enough, whether you are
logged in, which Cloudflare account, whether the database/queue/secret/site/key already exist, and
what still needs doing.

Skip the questions entirely for CI or an unattended run:

```sh
facet init --yes --workers-dev --site-name "My Site" --site-domain example.com
```

`--yes` accepts every default; a non-TTY does the same automatically, printing each choice it made.
To see the plan without touching anything:

```sh
facet init --dry-run
```

## What it does, in order

1. **Dependencies** — runs `pnpm install` if `node_modules` is missing.
2. **D1 database** — reuses the id in `wrangler.jsonc` if it exists on your account, else reuses a
   database of the same name, else creates one; writes the id into `apps/server/wrangler.jsonc`
   with a targeted edit that preserves every comment.
3. **Ingest queue** — creates `facet-ingest`. Cloudflare Queues needs the Workers Paid plan; if you
   are on the free plan the installer offers to comment the binding out, and ingest falls back to a
   synchronous D1 write.
4. **Public hostname** — sets your custom-domain route, or comments it out for `*.workers.dev`.
5. **Migrations** — `wrangler d1 migrations apply --remote`.
6. **Dashboard build** — the Worker serves it as static assets.
7. **Deploy** — then waits for `/api/health` to answer.
8. **Admin token** — generates 32 random bytes, pipes them to `wrangler secret put ADMIN_TOKEN` on
   stdin, and saves a copy to `apps/server/.dev.vars` at mode 0600.
9. **Site** — creates it, or reuses the one with that domain.
10. **API key** — issues one and prints it **once**.

## Secrets

- The admin token is **never printed**, never passed as a command-line argument (argv is visible to
  every process on the machine via `ps`), and never echoed into your shell history. It travels to
  wrangler on stdin and lives in `apps/server/.dev.vars`, mode 0600, which is gitignored.
- The API key is printed **once**, because only its hash is stored server-side — it is unrecoverable
  by design. It is not written to any file. Copy it into the dashboard when you open it.
- The dashboard is not pre-loaded with the key through a URL, deliberately: URLs land in shell
  history, server logs, and browser history. Paste it into the **Add site** dialog instead; it is
  stored in your browser only.
- `.facet/install.json` records the deployment URL and site id so a re-run can resume. It carries no
  secret and ignores itself in git.

Lost the key? Issue another with `facet init --new-key`. Lost the admin token? `facet init
--rotate-admin-token` replaces it.

## When something goes wrong

```sh
facet doctor
```

reports what is configured, what is missing, and what to run — with no secret values in it, so it is
safe to paste into a bug report.

Every installer failure names the cause, the fix, and how to resume. The common ones:

| What you see | What to do |
| --- | --- |
| `wrangler was not found` | `pnpm install` in the repo root, or `npm i -g wrangler@4` |
| `wrangler … is too old` | Facet needs v4+; `pnpm install` gets the pinned one |
| `wrangler is not logged in` | `wrangler login`, or export `CLOUDFLARE_API_TOKEN` |
| `no account attached` | create or join a Cloudflare account first |
| `more than one Cloudflare account` | export `CLOUDFLARE_ACCOUNT_ID` for the one you want |
| `maximum number of databases` | delete an unused D1 database, or `facet init --db <existing>` |
| `Queues needs the Workers Paid plan` | answer yes to run without it, or subscribe |
| `zone … not on this account` | add the domain to Cloudflare, or `facet init --workers-dev` |
| `did not answer /api/health` | a new custom domain needs a few minutes; re-run after |
| `rejected the admin token` | `facet init --rotate-admin-token` |
| `points at database … your account does not have` | you are signed in to the wrong account; `wrangler login`, or `facet init --force-db-id` |

## Add the tracker

The installer prints this with your values filled in:

```html
<script defer src="https://your-deployment.example.com/script.js" data-site-id="YOUR_SITE_ID"></script>
```

See [Usage](./usage.md) for the npm client, custom events, and the compatibility globals.

## Doing it by hand

Every step above is a command you can run yourself — see
[Self-hosting](./self-hosting.md#manual-deploy) if you would rather not hand your account to an
installer, or you are wiring Facet into an existing deployment pipeline.
