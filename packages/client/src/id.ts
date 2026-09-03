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

// IMPORTANT: only a token this file minted is trusted. localStorage is writable by every other script
// on the host page, and this value goes to /api/flags/eval as the bucketing key, so an unvalidated
// read would ship whatever a third party planted there: the cross-site identifier this id must never
// be. Re-minting also self-heals a stored value past the server's 128-char bound, which otherwise
// fails every eval for that visitor forever.
const ID_RE = /^[\da-f]{16}$/;

/** Read (or lazily create) the stable local id. Falls back gracefully without storage. */
export function localId(): string {
	const existing = safeGet(STORAGE_KEY);
	if (existing && ID_RE.test(existing)) return existing;
	const id = randomHex();
	safeSet(STORAGE_KEY, id);
	return id;
}

/** A short-lived id for one event. It is never persisted and therefore cannot identify a visitor. */
export function eventId(): string | undefined {
	return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : undefined;
}
