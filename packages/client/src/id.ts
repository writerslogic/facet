// The stable, local, per-browser id used for BOTH experiment and flag bucketing. It lives in
// localStorage under `facet.exp`, is random (never derived from anything identifying), and is NEVER
// sent to the server as identity — the server receives it only as an opaque bucketing key on /eval,
// exactly as the experiments client uses it locally. Sharing one id keeps a visitor's experiment and
// flag assignments drawn from the same stable seed. Zero dependencies.

import { safeGet, safeSet } from './optout.js';

const STORAGE_KEY = 'facet.exp';

/** 16 hex chars from crypto if available, else a Math.random fallback. */
function randomHex(): string {
	const bytes = new Uint8Array(8);
	if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

/** Read (or lazily create) the stable local id. Falls back gracefully without storage. */
export function localId(): string {
	const existing = safeGet(STORAGE_KEY);
	if (existing) return existing;
	const id = randomHex();
	safeSet(STORAGE_KEY, id);
	return id;
}
