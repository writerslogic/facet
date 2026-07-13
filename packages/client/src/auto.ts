// Auto-init side-effect bundle loaded via <script data-site-id ...>. Reads data-* attributes,
// installs the window.umami-compatible shim, and fires an initial pageview. Logic lands in T013.

import type { init, track } from './index.js';

declare global {
	interface Window {
		/** umami-compatible global: window.umami.track(name, props). */
		umami?: { track: typeof track };
		countless?: { track: typeof track; init: typeof init };
	}
}
