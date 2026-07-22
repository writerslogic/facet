<!-- Usage guide: installing the client and tracking events. -->

# Usage

Add tracking to a site by dropping in the script tag, or by importing the `@writerslogic/facet`
package and calling `track()` yourself. Both send the same beacon to
`POST /api/collect` on your deployment.

You need a **site ID** (a UUID) first. Create one with the admin API — see
[Self-hosting → Create a site and API key](./self-hosting.md#create-a-site-and-api-key).

## Script tag (drop-in for umami)

Add one line to your `<head>`. Replace the host with your deployment origin and
`YOUR_SITE_ID` with the site UUID:

```html
<script
  defer
  src="https://your-deployment.example.com/script.js"
  data-site-id="YOUR_SITE_ID"
></script>
```

The bundle reads `data-site-id`, installs the compatibility globals, and fires an
initial pageview automatically. Beacons are sent with `navigator.sendBeacon` when
available, falling back to a `keepalive` `fetch`.

## npm (programmatic)

Install the browser client:

```sh
npm install @writerslogic/facet
```

Configure it once with `init(...)`, then call `track()`:

```ts
import { init, track } from '@writerslogic/facet';

init({
  host: 'https://your-deployment.example.com',
  siteId: 'YOUR_SITE_ID',
});

// Pageview (no name):
track();

// Named custom event:
track('signup', { plan: 'pro' });
```

`init` takes a `host` (the collect endpoint origin — Facet appends `/api/collect`)
and a `siteId`. Until `init` is called, `track()` is a no-op. `track()` reads
`location.hostname`, `location.pathname`, and `document.referrer` from the browser, and
appends any `utm_source` / `utm_medium` / `utm_campaign` query parameters as `utm`.

## Automatic UTM & form tracking

The client captures marketing attribution and form submissions with no extra code:

- **UTM capture** — every beacon reads `utm_source`, `utm_medium`, and `utm_campaign`
  from the current URL's query string and sends them as `utm: { source, medium, campaign }`
  (only the params that are present). The server uses these to classify each event's
  [traffic channel](./api.md#traffic-channels) (paid / email / social / organic / direct /
  internal / referral).
- **Form submissions** — when loaded via the script tag, the client auto-tracks form
  submits as a `form_submit` event with props `form_id`, `form_name`, and `action` (any of
  which may be `null`). **No field values are ever read.** Opt a form out by adding
  `data-facet-ignore` to the `<form>`:

  ```html
  <form data-facet-ignore>
    <!-- this form's submits are not tracked -->
  </form>
  ```

## umami compatibility

Facet installs umami-compatible globals so existing umami sites migrate by swapping
a single script tag:

```js
// umami call sites keep working:
window.umami.track('signup', { plan: 'pro' });

// The native global exposes the same track (plus init):
window.facet.track('signup', { plan: 'pro' });
```

`window.umami.track(name, props)` and `window.facet.track(name, props)` both call
the same `track()`.

## Custom events with props

Pass an event `name` and an optional `props` object. Props are validated server-side:

- Up to **24** keys.
- Keys are 1–40 characters.
- Values may be a string (≤ 500 characters), a finite number, a boolean, or `null`.

```ts
track('purchase', {
  plan: 'pro',
  seats: 5,
  trial: false,
});
```

A payload that violates these limits is rejected with `400 validation_failed`; see the
[API reference](./api.md).

## Visitor opt-out & Do Not Track

Facet honors **Do Not Track by default**: if the browser sends a DNT signal
(`navigator.doNotTrack === '1'`, `window.doNotTrack === '1'`, `navigator.doNotTrack === 'yes'`,
or `navigator.msDoNotTrack === '1'`) the visitor is treated as opted out, and no beacons are
sent — no pageview, no SPA navigations, no `form_submit`, no UTM read, and no experiment fetch,
bucketing, or `$exposure`.

There are three controls, in precedence order (highest first):

1. **`localStorage['facet.optout']`** — the visitor's persistent choice. `'1'`/`'true'` opts out;
   `'0'`/`'false'` is an explicit opt-in that **overrides Do Not Track** (a deliberate per-visitor
   decision wins over the browser default).
2. **`data-facet-optout`** on the script tag — opts out when present and not a false-like value.
3. **Do Not Track** browser signals.

Opt a whole site's script out (e.g. for a self-hosted embed you only want on consent):

```html
<script
  defer
  src="https://your-deployment.example.com/script.js"
  data-site-id="YOUR_SITE_ID"
  data-facet-optout
></script>
```

A false-like value (`false`, `0`, `no`, `off`) leaves tracking **on**:

```html
<!-- tracking stays enabled -->
<script ... data-facet-optout="false"></script>
```

Give visitors a persistent toggle from your own UI. The effect is immediate:

```ts
import { optOut, optIn, isOptedOut } from '@writerslogic/facet';
// or window.facet.optOut() / optIn() / isOptedOut() with the script tag.

optOut(); // sets localStorage['facet.optout'] = '1'; all collection stops now
optIn(); //  sets '0'; re-enables tracking and overrides Do Not Track
isOptedOut(); // current effective state (re-read on every call)
```

Storage access is wrapped so a blocked or unavailable `localStorage` (private mode, disabled
storage) never throws — it degrades to an in-memory value for the page load.

## Experiments: variant() and assignment()

Read a flag's assigned variant with `variant(flagKey)`. Bucketing is computed locally; only an
aggregate `$exposure` event is sent (see [privacy](./privacy.md)).

```ts
import { variant } from '@writerslogic/facet';
const v = variant('cta'); // 'control' | 'blue' | …
```

`variant()` is **synchronous and always returns a string**. Before the experiment config has
loaded (or when the flag is unknown, the fetch failed, or the visitor is opted out) it returns a
safe fallback — the flag's control/first variant if known, else `'control'` — and does **not** fire
an exposure. That fallback is **not a confirmed assignment**: rendering on it directly can flash the
control variant before the real assignment loads.

To render without a flash, gate on `whenReady()`, which resolves once init and the experiments
fetch have settled (it never rejects):

```ts
import { whenReady, variant } from '@writerslogic/facet';

await whenReady(); // resolves on success OR failure of the /active fetch
render(variant('cta')); // now a confirmed assignment (or a genuine fallback on failure)
```

When you need to distinguish a real assignment from a pending/failed/opted-out state, use
`assignment()`:

```ts
import { assignment } from '@writerslogic/facet';

const a = assignment('cta');
// { variant: string; participating: boolean;
//   status: 'assigned' | 'pending' | 'unavailable' | 'opted-out' }
if (a.participating) {
  // status === 'assigned': a genuine bucketing; an exposure fired exactly once for this flag.
  render(a.variant);
}
```

`participating` is `true` only for a genuine bucketed assignment, so an opted-out or still-loading
state is never misreported as a real control.

Repeated `whenReady()` calls return the same promise; calling it (or `variant()`/`assignment()`)
before `init()` is safe.

## Feature flags: flag(), flagBool() and allFlags()

Feature flags differ from experiments: they support server-side **targeting rules** (by country,
device, path, custom attributes, or a sticky percentage), so they evaluate on the server rather than
in the browser. The SDK sends only the stable `facet.exp` id plus non-identifying context and caches
the assignment map for the page; the server applies the full ruleset with the same shared evaluator
used everywhere else.

```js
import { whenFlagsReady, flag, flagBool, flagAssignment } from '@writerslogic/facet';

await whenFlagsReady(); // one POST /api/flags/eval; resolves on success OR failure
if (flagBool('new-checkout')) render(newCheckout()); // true only when the assigned variant is `on`
const theme = flag('theme'); // '' until ready / when opted-out / unknown flag
```

Like `variant()`, the readers are **synchronous**. Before `whenFlagsReady()` resolves — and whenever
the visitor is opted out — every flag reads as a safe default (variant `''`, `flagBool` → `false`, so
features default **off**). Use `flagAssignment(key)` to distinguish the states via its `reason`
(`pending | opted-out | unknown | disabled | rollout | rule:<n> | gpc`); `participating` is `true`
only for a genuine assignment. `allFlags()` returns the whole loaded map. Country and device targeting
are resolved authoritatively by the server from the request, so the browser never needs to (and
cannot) supply them.
