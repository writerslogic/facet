<!-- Usage guide: installing the client and tracking events. Filled in by T032. -->

# Usage

> Stub — expanded in T032.

## Script tag (drop-in for umami)

```html
<script defer src="https://your-deployment.example.com/script.js"
        data-site-id="YOUR_SITE_ID"></script>
```

Auto-pageviews and `window.umami.track(name, props)` work unchanged.

## npm

```sh
npm install countless
```

```ts
import { track } from 'countless';
track('signup', { plan: 'pro' });
```
