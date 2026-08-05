<!-- Privacy model: cookieless, salted-hash unique counting. -->

# Privacy model

Facet is cookieless and stores no personal identifiers. There are no cookies and no server-stored
cross-site or cross-day identifiers; the only client-side storage is an opt-out switch and, when
experiments or feature flags are used, a random local bucketing id (see
[Visitor opt-out, Do Not Track & Global Privacy Control](#visitor-opt-out-do-not-track--global-privacy-control)),
neither of which is stored server-side as an identifier. **Raw IP addresses are never
stored, logged, or returned** — an IP is read only inside the hash function below and is
discarded immediately after.

## Visitor hash

Unique visitors are counted with a daily-rotating, salted `SHA-256` hash. The exact
formula as implemented:

```
visitor_hash = SHA-256( ip | user_agent | daily_salt | site_id )
```

- The fields are joined in exactly that order.
- The delimiter is a single pipe character (`|`, the `HASH_DELIMITER` constant).
- The result is the lowercase 64-character hex digest of the SHA-256 hash.

Concretely, the input string is `ip + "|" + user_agent + "|" + daily_salt + "|" + site_id`,
and the stored value is its SHA-256 hex digest.

## Daily salt and UTC-day scoping

There is exactly one salt per **UTC day**. The salt is 32 random bytes (rendered as hex),
created lazily and race-safely the first time an event arrives on a given UTC day, keyed
by its `YYYY-MM-DD` UTC day key.

Because the salt is an input to the hash and rotates every UTC day, a given visitor
produces a **different, unlinkable hash on each UTC day**. Uniqueness is therefore scoped
to a single UTC day: cross-day re-identification is cryptographically prevented, and there
is **no multi-salt lookback** — a hash is only ever computed and compared against the
current day's salt.

## Daily-uniques semantics

Because uniqueness resets each UTC day, a visitor who returns on `N` distinct UTC days
counts as `N` unique visitors over a multi-day range. Distinct-visitor counts are exact
per day, not deduplicated across days. This is the intended, privacy-preserving trade-off:
the system cannot link the same person across days even in principle.

## Identity spectrum (opt-in, consent-gated)

The daily-rotating anonymous hash above is the **default and requires no configuration** — a site
with no identity config behaves exactly as described, byte for byte. A site that needs
returning-visitor or retention analysis can opt into a wider linkage window, one tier at a time.
Linkability is the single axis:

| Tier | Pre-image | Salt window | Gate |
| --- | --- | --- | --- |
| **anonymous** (default) | `ip \| ua \| salt \| siteId` | day (rotates daily) | none |
| **pseudonymous** | `ip \| ua \| salt \| siteId` | day / week / month | signed consent |
| **identified** | `uid:<uid> \| salt \| siteId` | day / week / month | signed consent + per-event `consent:true` |

The mechanism is a generalization of the daily salt: one secret 32-byte salt **per window** (e.g. one
per ISO week). A visitor is **stable within a window** (same salt → same hash) and **unlinkable across
windows** (a new window mints a fresh random salt), exactly like the daily rotation, just at the chosen
granularity. There is deliberately **no "never" window** — every salt is destroyed by retention once
its window closes, so cross-window linkage is always bounded by `RAW_RETENTION_DAYS`. `siteId` is in
every pre-image, so the same visitor on two sites yields **unrelated** hashes (no cross-site
super-cookie), and the `uid:` prefix means an identified pre-image can never collide with an anonymous
one.

**Elevation is gated by a signed consent record**, never a config flag alone. The site collects the
visitor's real consent (via its own CMP) and calls `POST /api/consent`; the deployment signs a
PII-free statement (`facet-consent/1`) over the derived hash, tier, and window — **never** ip, ua, or
raw uid. At ingest, an event is elevated only if an active consent record exists whose signature
verifies **against the deployment key** and whose signed claims are **bound to the exact ingest
context** (site, hash, tier, window); otherwise the event silently **downgrades to the anonymous
Tier-0 hash** (never dropped). Any tier above anonymous requires a configured deployment signing key;
without one, every site stays at Tier 0.

**GPC always wins over consent.** The `Sec-GPC: 1` signal is checked before any elevated pre-image is
built, in ingest and at `POST /api/consent` alike, so a GPC visitor is never elevated — regardless of
tier, window, or any stored consent. At ingest the event is **forced to the anonymous Tier-0 day
hash**; at `POST /api/consent` the request is refused with `202 Accepted` and no consent record is
written. Consent (opt-in, widens linkage) and GPC (opt-out, forbids it) never conflict: GPC is
evaluated first and unconditionally. GPC blocks *elevation*, not *counting* — the event itself is
still ingested and still counted; see
[Visitor opt-out, Do Not Track & Global Privacy Control](#visitor-opt-out-do-not-track--global-privacy-control).

**Threat model for the identified tier.** A Tier-2 `uid:` hash is re-identifiable **by the site that
supplied the uid** (that is the point — CRM join); the guarantees are per-site isolation and
Facet-side non-reversibility, not anonymity. The raw uid is stored at rest only to support
uid-scoped revocation and is purged by retention/erasure. Per-event `consent:true` is a caller
attestation (as trustworthy as the site's backend, exactly like the caller-supplied IP on
`/api/event`), not an end-user cryptographic guarantee.

## Sessions & UTM

Sessions are **derived from raw events**, never sent by the client. On the cron, a day's
events for each `(site, visitor)` are folded into sessions, splitting on any inactivity gap
longer than 30 minutes. A session row carries **no raw IP and no raw user-agent** — it
references the visitor only through the same daily `visitor_hash`, and its own id is a
non-reversible `SHA-256` digest of `site_id | visitor_hash | started_at`. Because a session
is keyed on the daily hash, sessions inherit the **daily un-linkability** of the visitor
hash: the same person's sessions on two different UTC days cannot be linked, even in
principle.

UTM values (`utm_source`, `utm_medium`, `utm_campaign`) are **site-supplied marketing
tags** taken verbatim from the page URL. They are stored only in their own declared columns
and used to classify each event's traffic channel; they are not identifiers and are not
mixed into the visitor hash.

## Visitor opt-out, Do Not Track & Global Privacy Control

Facet distinguishes a **passive browser signal** (DNT / GPC) from a **deliberate opt-out**
(the localStorage kill switch or the `data-facet-optout` attribute). They are not equivalent, and
only the deliberate opt-out stops collection.

### What DNT and GPC do

The recognized signals are DNT (`navigator.doNotTrack === '1'`, `window.doNotTrack === '1'`,
`navigator.doNotTrack === 'yes'`, or `navigator.msDoNotTrack === '1'`) and
[Global Privacy Control](https://globalprivacycontrol.org/)
(`navigator.globalPrivacyControl === true` in the browser, and the `Sec-GPC: 1` header on the
server). When one is present:

- **Experiments are off.** No `/api/experiments/active` fetch, no local bucketing, no `$exposure`.
  `assignment()` reports status `opted-out` and `participating: false`.
- **Feature flags are off.** No `POST /api/flags/eval` from the SDK; every flag reads its safe
  default (variant `''`, `flagBool()` → `false`). A `/eval` request that does carry `Sec-GPC: 1` is
  answered with each flag's default variant, `participating: false`, `reason: 'gpc'`.
- **Identity elevation is off.** `Sec-GPC: 1` forces the anonymous Tier-0 day hash at ingest, so a
  GPC visitor is never pseudonymous or identified regardless of tier, window, or stored consent, and
  `POST /api/consent` refuses to mint a consent record for that visitor at all.

### What DNT and GPC do not do

**They do not suppress the pageview.** With DNT or GPC set and no deliberate opt-out, the client
still sends the initial pageview, SPA navigation pageviews, `form_submit`, and the UTM read; and
the server still writes the row. There is **no server-side drop**: a `POST /api/collect` or
`POST /api/event` request carrying `Sec-GPC: 1` is ingested like any other, pinned to the anonymous
hash. Facet counts a GPC visitor's pageviews.

That is deliberate, and it follows from the scope of the signal. DNT and GPC assert that the visitor
does not consent to the tracking or sale of **personal** data. An anonymous, cookieless pageview
carries none — no cookie, no cross-day identifier, no retained IP, nothing that survives the daily
salt rotation — so counting it keeps total-traffic figures accurate without collecting personal
data. This is the same trade-off Plausible and Fathom make.

If you need DNT/GPC to suppress collection outright, that is not what this code does; wire the
signal to the explicit opt-out below yourself.

### How a visitor stops collection entirely

Exactly two controls suppress the beacon:

1. **`localStorage['facet.optout']` set to `'1'` or `'true'`** — the visitor's persistent kill
   switch, set by `optOut()` (or `window.facet.optOut()` with the script tag).
2. **`data-facet-optout` on the script tag**, present and not a false-like value
   (`false`/`0`/`no`/`off`) — a site-wide switch, e.g. for an embed you only enable after consent.

With either set, `track()` returns before it builds a payload — no pageview, no SPA navigation, no
`form_submit`, no UTM read — and the auto bundle installs no history or submit listeners at all. The
public API (`optIn`, `optOut`, `isOptedOut`, `whenReady`) stays callable, so a visitor can opt back
in.

### Precedence

Two gates read the same state. They share a precedence chain and differ only in the last step:
whether a passive browser signal counts as opt-out.

| Step | State | Beacon gate (pageviews, custom events) | Experiment / flag gate |
| --- | --- | --- | --- |
| 1 | `localStorage['facet.optout']` is `'1'`/`'true'` | opted **out** | opted **out** |
| 2 | `localStorage['facet.optout']` is `'0'`/`'false'` | opted **in** | opted **in** (overrides DNT/GPC) |
| 3 | `data-facet-optout` present, not false-like | opted **out** | opted **out** |
| 4 | DNT or GPC browser signal | *ignored* — opted **in** | opted **out** |
| 5 | Otherwise | opted **in** | opted **in** |

An explicit `localStorage` opt-in (`'0'`/`'false'`) overrides DNT and GPC **client-side only**,
because it is a deliberate per-visitor choice. It cannot override the server: the browser keeps
sending `Sec-GPC: 1`, so ingest still forces the Tier-0 hash and `/api/flags/eval` still answers
`reason: 'gpc'`.

Facet's client-side storage is two `localStorage` keys, neither a cookie and neither stored
server-side as an identifier:

- **`facet.optout`** — the opt-out switch. Never sent anywhere.
- **`facet.exp`** — a random 16-hex-character id, shared by experiments and feature flags, created
  lazily on first use. Experiment bucketing is computed from it entirely in the browser and only an
  aggregate `$exposure` carrying `{ flag, variant }` is sent. Feature-flag evaluation happens on the
  server, so the id **is** sent in the `POST /api/flags/eval` body as an opaque bucketing key; the
  server uses it to compute assignments and writes it to no row. It is not derived from anything
  identifying and is never mixed into the visitor hash, but it does persist in that browser until
  storage is cleared.

Storage access is wrapped so a blocked or disabled `localStorage` never throws — it degrades to an
in-memory value for the page load.

## Retention

Raw data is purged past a rolling window, `RAW_RETENTION_DAYS` (default **90** days,
configurable in `apps/server/wrangler.jsonc`). On the hourly cron, everything older than
the window is deleted:

- raw **events**
- **sessions**
- daily **salts**
- windowed **identity salts** (purged on window *end*, so a salt always outlives every event in its
  window)
- **consent records**, including the at-rest raw uid

Deleting the old salts means expired days can never be re-hashed even if raw input somehow
resurfaced. **Aggregated rollups are durable and are never deleted**, so long-range trend
history survives without retaining any raw, potentially re-identifiable rows.

**Magic-link tokens** are swept by the same cron, but on their own expiry rather than
`RAW_RETENTION_DAYS` — a sign-in link lives 15 minutes, so ageing it out over ninety days would
retain it for the other eighty-nine. This is the one row in the system that holds an email address
for somebody who is not (yet) an operator: `POST /api/auth/request` deliberately cannot check
whether an address has an account before writing, because that check is what would leak the answer.
Once the link expires the row is deleted, so an address that was typed into the sign-in form —
correctly or not — and never used leaves nothing behind.

**Analytics Engine.** A deployment may additionally bind Analytics Engine as a columnar mirror of
the same derived event columns (no new identifier, no raw IP — see
[`apps/server/src/lib/ae.ts`](../apps/server/src/lib/ae.ts)). Cloudflare stores an AE data point for
three months and exposes no delete API, so the mirror cannot be purged on Facet's schedule. Rather
than let that quietly shorten what the deployment can honor, **the mirror is disabled whenever
`RAW_RETENTION_DAYS` is set below 90** — configure a shorter window and the deployment stays
D1-only. The window that is enforced, the window the mirror is gated on, and the window signed into
the privacy attestation all read the same setting through one function, so they cannot diverge.

## What is never stored

- Raw IP addresses (used only transiently to compute the hash).
- Cookies, of any kind, first- or third-party.
- The `facet.exp` bucketing id — it exists only in the visitor's `localStorage`; the server reads it
  to evaluate flags and persists it nowhere.
- At the default anonymous tier: any identifier that links a visitor across two UTC days. (A site
  that has explicitly opted into a wider salt window links within that window instead — see
  [Identity spectrum](#identity-spectrum-opt-in-consent-gated).)

Country is derived from Cloudflare's edge metadata and coarsened (anonymized `XX` and Tor
`T1` are dropped to `null`); device is a coarse `mobile` / `tablet` / `desktop` class
inferred from the user-agent.
