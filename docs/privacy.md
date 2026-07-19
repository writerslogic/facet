<!-- Privacy model: cookieless, salted-hash unique counting. -->

# Privacy model

Facet is cookieless and stores no personal identifiers. There are no cookies and no cross-site or
cross-day identifiers; the only client-side storage is a local-only opt-out switch and, when
experiments are used, a local A/B bucketing id (see
[Visitor opt-out & Do Not Track](#visitor-opt-out--do-not-track)), neither of which is sent as
identity. **Raw IP addresses are never
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

**Do Not Track and Global Privacy Control are honored by default.** When the browser signals DNT
(`navigator.doNotTrack === '1'`, `window.doNotTrack === '1'`, `navigator.doNotTrack === 'yes'`, or
`navigator.msDoNotTrack === '1'`) or [Global Privacy Control](https://globalprivacycontrol.org/)
(`navigator.globalPrivacyControl === true`) the client sends nothing: no pageview, no SPA navigation
events, no `form_submit`, no UTM read, and no experiment fetch, bucketing, or `$exposure`.

GPC is also enforced **server-side**: any request to `POST /api/collect` or `POST /api/event`
carrying the `Sec-GPC: 1` header is dropped with `202 Accepted` before the visitor hash is derived
or any row is written — so the opt-out holds even for callers that bypass the JavaScript client.

Opt-out state has a single precedence chain (highest first):

1. **`localStorage['facet.optout']`** — the visitor's persistent switch and their override.
   `'1'`/`'true'` opts out; `'0'`/`'false'` is an explicit opt-in that **overrides DNT and GPC**,
   because it is a deliberate per-visitor choice and takes priority over the browser default.
2. **`data-facet-optout`** on the script tag — opts out unless set to a false-like value
   (`false`/`0`/`no`/`off`).
3. **Do Not Track** and **Global Privacy Control** browser signals.
4. Otherwise opted in.

The only client-side storage Facet uses is local-only and never sent as identity: the opt-out
switch `localStorage['facet.optout']` and, when experiments are used, the per-experiment bucketing
id `localStorage['facet.exp']` (a random value used solely to compute local A/B assignment; only an
aggregate `$exposure` carrying `{ flag, variant }` reaches the server). Neither is a cookie, a
cross-site identifier, or linkable across days. Storage access is wrapped so a blocked or disabled
`localStorage` never throws.

## Retention

Raw data is purged past a rolling window, `RAW_RETENTION_DAYS` (default **90** days,
configurable in `apps/server/wrangler.jsonc`). On the hourly cron, everything older than
the window is deleted:

- raw **events**
- **sessions**
- daily **salts**

Deleting the old salts means expired days can never be re-hashed even if raw input somehow
resurfaced. **Aggregated rollups are durable and are never deleted**, so long-range trend
history survives without retaining any raw, potentially re-identifiable rows.

## What is never stored

- Raw IP addresses (used only transiently to compute the hash).
- Cookies or any client-side persistent identifier.
- Any identifier that links a visitor across two UTC days.

Country is derived from Cloudflare's edge metadata and coarsened (anonymized `XX` and Tor
`T1` are dropped to `null`); device is a coarse `mobile` / `tablet` / `desktop` class
inferred from the user-agent.
