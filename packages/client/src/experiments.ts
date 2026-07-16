// Client-side A/B variant assignment. Privacy-first: bucketing is computed locally from a random id
// in localStorage (`countless.exp`) that is NEVER sent to the server as identity. The server only
// receives an aggregate `$exposure` event carrying { flag, variant }. Zero dependencies.

import { getConfig, track } from './index.js';

interface FlagDef {
	flag_key: string;
	variants: { key: string; weight: number }[];
}

const STORAGE_KEY = 'countless.exp';
const CONTROL = 'control';

let flags: FlagDef[] | null = null;
let fetching = false;
const exposed = new Set<string>();

/** Load active flag definitions once and cache them in a module var. */
function loadFlags(): void {
	if (flags !== null || fetching) return;
	const config = getConfig();
	if (!config || typeof fetch === 'undefined') return;
	fetching = true;
	fetch(`${config.host}/api/experiments/active?site_id=${config.siteId}`)
		.then((r) => r.json())
		.then((body: { experiments?: FlagDef[] }) => {
			flags = body.experiments ?? [];
		})
		.catch(() => {
			flags = [];
		});
}

/** Read (or lazily create) the stable local experiment id. Falls back gracefully without storage. */
function localId(): string {
	try {
		const existing = localStorage.getItem(STORAGE_KEY);
		if (existing) return existing;
		const id = randomHex();
		localStorage.setItem(STORAGE_KEY, id);
		return id;
	} catch {
		return randomHex();
	}
}

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

/** Small deterministic FNV-1a-style string hash → unsigned 32-bit. */
function hashString(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Map the hash to a variant key using cumulative weights. */
function pick(def: FlagDef, id: string): string {
	const total = def.variants.reduce((sum, v) => sum + v.weight, 0);
	if (total <= 0) return def.variants[0]?.key ?? CONTROL;
	const point = (hashString(`${id}|${def.flag_key}`) / 0x100000000) * total;
	let acc = 0;
	for (const v of def.variants) {
		acc += v.weight;
		if (point < acc) return v.key;
	}
	return def.variants[def.variants.length - 1]?.key ?? CONTROL;
}

/**
 * Resolve the assigned variant for `flagKey`. Returns 'control' until the flag config has loaded.
 * On first resolution of a known flag, fires exactly one `$exposure` event (deduped per page load).
 */
export function variant(flagKey: string): string {
	loadFlags();
	if (flags === null) return CONTROL;
	const def = flags.find((f) => f.flag_key === flagKey);
	if (!def || def.variants.length === 0) return CONTROL;
	const chosen = pick(def, localId());
	if (!exposed.has(flagKey)) {
		exposed.add(flagKey);
		track('$exposure', { flag: flagKey, variant: chosen });
	}
	return chosen;
}
