// Auto-init side-effect bundle loaded via <script src=".../script.js" data-site-id="…">. Reads the
// executing script's data-* attributes, installs the window.umami-compatible shim, fires an initial
// pageview, and auto-tracks SPA navigations (history pushState/replaceState + popstate). Every
// collection path is gated on the shared opt-out state (Do-Not-Track, data-facet-optout, and the
// localStorage kill switch).

import { assignment, variant, whenReady } from './experiments.js';
import { init, track } from './index.js';
import { isOptedOut, optIn, optOut, setOptOutScript } from './optout.js';

declare global {
	interface Window {
		/** umami-compatible global: window.umami.track(name, props). */
		umami?: { track: typeof track };
		facet?: {
			track: typeof track;
			init: typeof init;
			variant: typeof variant;
			assignment: typeof assignment;
			whenReady: typeof whenReady;
			optOut: typeof optOut;
			optIn: typeof optIn;
			isOptedOut: typeof isOptedOut;
		};
	}
}

function boot(): void {
	if (typeof document === 'undefined') return;
	const el = document.currentScript as HTMLScriptElement | null;
	setOptOutScript(el);
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

	// Expose the public API regardless of opt-out state so optIn()/optOut() remain callable, and so
	// whenReady() always resolves. track() and the experiments module self-gate on opt-out.
	if (typeof window !== 'undefined') {
		window.umami = { track };
		window.facet = {
			track,
			init,
			variant,
			assignment,
			whenReady,
			optOut,
			optIn,
			isOptedOut,
		};
	}
	// Resolve readiness even when opted out or when there are no experiments to fetch.
	void whenReady();

	if (isOptedOut()) return;

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
	// Auto-track form submissions (no field values are ever read). Opt out with data-facet-ignore.
	document.addEventListener(
		'submit',
		(event) => {
			const form = event.target as HTMLFormElement | null;
			if (!form || form.tagName !== 'FORM' || form.hasAttribute('data-facet-ignore')) return;
			track('form_submit', {
				form_id: form.id || null,
				form_name: form.getAttribute('name') || null,
				action: form.getAttribute('action') || null,
			});
		},
		true,
	);

	if (typeof window !== 'undefined') {
		window.addEventListener('popstate', () => track());
	}
}

boot();
