// Auto-init side-effect bundle: reads the script's data-* attributes, installs the umami shim, and
// auto-tracks pageviews and SPA navigations. Every collection path is gated on the opt-out state.

import { assignment, variant, whenReady } from './experiments.js';
import { init, track } from './index.js';
import { isExplicitlyOptedOut, isOptedOut, optIn, optOut, setOptOutScript } from './optout.js';

declare global {
	interface Window {
		/** Set by the first boot() to run on this page. A second, independently loaded script
		 * instance (theme + plugin both embedding the tag) doesn't share module scope with the
		 * first, so this has to live on window, not a module-local variable, to be visible across
		 * the two instances and stop the page from double-counting every real event. */
		__facetBooted?: boolean;
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

// A SPA router normalizes the URL on mount (react-router's BrowserRouter replaceStates the resolved
// location), firing a patched replaceState microseconds after the initial pageview and double-counting
// every landing. Collapse a pageview that repeats the path of the one just sent. Only the LAST sent
// path is compared, so A→B→A still counts three times, and the timestamp is only advanced on a sent
// beacon, so a router that keeps rewriting the same path can't hold the gate open indefinitely.
const REPEAT_PAGEVIEW_MS = 500;
let lastPath: string | null = null;
let lastSentAt = 0;

/** Send an auto-tracked pageview unless it duplicates the immediately preceding one. */
function trackPageview(): void {
	const path = (typeof location !== 'undefined' ? location.pathname : '') || '/';
	const now = Date.now();
	if (path === lastPath && now - lastSentAt < REPEAT_PAGEVIEW_MS) return;
	lastPath = path;
	lastSentAt = now;
	track();
}

function boot(): void {
	if (typeof window !== 'undefined') {
		if (window.__facetBooted) return;
		window.__facetBooted = true;
	}
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

	// A deliberate opt-out installs no trackers at all; a passive GPC/DNT signal still counts anonymously.
	if (isExplicitlyOptedOut()) return;

	trackPageview();

	if (typeof history !== 'undefined') {
		for (const type of ['pushState', 'replaceState'] as const) {
			const original = history[type];
			history[type] = function patched(
				this: History,
				...args: Parameters<History['pushState']>
			): void {
				original.apply(this, args);
				trackPageview();
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
		window.addEventListener('popstate', () => trackPageview());
	}
}

boot();
