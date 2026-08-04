import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom in this config does not expose Storage; provide a minimal in-memory implementation.
function makeStorage(): Storage {
	const store = new Map<string, string>();
	return {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (key) => (store.has(key) ? (store.get(key) ?? null) : null),
		key: (index) => Array.from(store.keys())[index] ?? null,
		removeItem: (key) => {
			store.delete(key);
		},
		setItem: (key, value) => {
			store.set(key, String(value));
		},
	};
}

if (!('localStorage' in globalThis) || globalThis.localStorage == null) {
	Object.defineProperty(globalThis, 'localStorage', {
		value: makeStorage(),
		configurable: true,
	});
}

if (!('sessionStorage' in globalThis) || globalThis.sessionStorage == null) {
	Object.defineProperty(globalThis, 'sessionStorage', {
		value: makeStorage(),
		configurable: true,
	});
}

// jsdom lacks these APIs that uPlot and its ResizeObserver wrapper reach for at import/mount.
if (!window.matchMedia) {
	window.matchMedia = (query: string): MediaQueryList =>
		({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}) as unknown as MediaQueryList;
}

if (!('ResizeObserver' in globalThis)) {
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
}

// React Testing Library needs explicit cleanup because vitest globals are off.
afterEach(() => {
	cleanup();
	// `restoreAllMocks` does not undo `stubGlobal`, so a test that stubs `fetch` and only restores
	// mocks leaves the stub installed. An unmounted tree's react-query request can still be in
	// flight, and it then resolves against the NEXT test's DOM — a failure that moves between files
	// and machines depending on which request loses the race. Unstubbing here covers every file
	// rather than relying on each one to remember.
	vi.unstubAllGlobals();
});
