// Auto-init side-effect bundle loaded via <script src=".../script.js" data-site-id="…">. Reads the
// executing script's data-* attributes, installs the window.umami-compatible shim, fires an initial
// pageview, and auto-tracks SPA navigations (history pushState/replaceState + popstate).

import { init, track } from './index.js';

declare global {
	interface Window {
		/** umami-compatible global: window.umami.track(name, props). */
		umami?: { track: typeof track };
		countless?: { track: typeof track; init: typeof init };
	}
}

function boot(): void {
	if (typeof document === 'undefined') return;
	const el = document.currentScript as HTMLScriptElement | null;
	const siteId = el?.getAttribute('data-site-id') ?? undefined;
	if (!siteId) return;

	let host = el?.getAttribute('data-host') ?? '';
	if (!host && el?.src) {
		try {
			host = new URL(el.src).origin;
		} catch {
			host = '';
		}
	}

	init({ siteId, host });
	track();

	if (typeof history !== 'undefined') {
		for (const type of ['pushState', 'replaceState'] as const) {
			const original = history[type];
			history[type] = function patched(
				this: History,
				...args: Parameters<History['pushState']>
			): void {
				original.apply(this, args);
				track();
			};
		}
	}
	if (typeof window !== 'undefined') {
		window.addEventListener('popstate', () => track());
		window.umami = { track };
		window.countless = { track, init };
	}
}

boot();
