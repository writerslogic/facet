<!-- Usage guide: installing the client and tracking events. -->

# Usage

Add tracking to a site by dropping in the script tag, or by importing the `countless`
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
npm install countless
```

Configure it once with `init(...)`, then call `track()`:

```ts
import { init, track } from 'countless';

init({
  host: 'https://your-deployment.example.com',
  siteId: 'YOUR_SITE_ID',
});

// Pageview (no name):
track();

// Named custom event:
track('signup', { plan: 'pro' });
```

`init` takes a `host` (the collect endpoint origin — Countless appends `/api/collect`)
and a `siteId`. Until `init` is called, `track()` is a no-op. `track()` reads
`location.hostname`, `location.pathname`, and `document.referrer` from the browser, and
appends any `utm_source` / `utm_medium` / `utm_campaign` query parameters as `utm`.

## umami compatibility

Countless installs umami-compatible globals so existing umami sites migrate by swapping
a single script tag:

```js
// umami call sites keep working:
window.umami.track('signup', { plan: 'pro' });

// The native global exposes the same track (plus init):
window.countless.track('signup', { plan: 'pro' });
```

`window.umami.track(name, props)` and `window.countless.track(name, props)` both call
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
