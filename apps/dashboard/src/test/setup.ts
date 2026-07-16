import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom in this config does not expose Storage; provide a minimal in-memory implementation.
if (!('localStorage' in globalThis) || globalThis.localStorage == null) {
	const store = new Map<string, string>();
	const storage: Storage = {
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
	Object.defineProperty(globalThis, 'localStorage', {
		value: storage,
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
});
