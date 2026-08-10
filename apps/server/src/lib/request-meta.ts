// Request metadata extraction: the segmentation dimensions, all derived at the Cloudflare edge from
// `request.cf` + request headers (or coarsened on-device by the tracker before they are sent). The raw
// IP is read here but never stored or logged; high-entropy values (exact UA, full Accept-Language, exact
// screen size) are deliberately never received in raw form — only their coarse category is kept. This is
// the "coarsen at the source" half of Facet's private-by-construction segmentation.

/** The client IP from Cloudflare's `CF-Connecting-IP` header, or `''` when absent. */
export function clientIp(req: Request): string {
	return req.headers.get('CF-Connecting-IP') ?? '';
}

/** ISO country code (uppercased), or `null` for unknown/anonymized (`XX`) and Tor (`T1`). */
export function country(req: Request): string | null {
	const cf = req.cf?.country;
	const raw = (typeof cf === 'string' ? cf : undefined) ?? req.headers.get('CF-IPCountry');
	if (!raw) {
		return null;
	}
	const code = raw.toUpperCase();
	if (code === 'XX' || code === 'T1') {
		return null;
	}
	return code;
}

/** Coarse device class inferred from the user-agent. */
export function device(userAgent: string): 'mobile' | 'tablet' | 'desktop' {
	if (/\bipad\b|\btablet\b/i.test(userAgent)) {
		return 'tablet';
	}
	if (/\b(?:mobile|android|iphone)\b|mobi/i.test(userAgent)) {
		return 'mobile';
	}
	return 'desktop';
}

// ── Geo / network (edge-derived from `request.cf`; the IP is never stored) ────────────────────────────

/** Trim a `request.cf` string field to a non-empty label, or `null`. City/region are kept raw here and
 * k-anonymously coarsened at query time (a city is only surfaced when its cohort clears the threshold). */
function cfLabel(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed && trimmed.toLowerCase() !== 'unknown' ? trimmed : null;
}

/** Sub-national region (e.g. "California"), edge-derived. Coarsened to country at read time below k. */
export function region(req: Request): string | null {
	return cfLabel(req.cf?.region);
}

/** City, edge-derived. High entropy for small populations, so the read path rolls it up under k-anon. */
export function city(req: Request): string | null {
	return cfLabel(req.cf?.city);
}

/** IANA timezone (e.g. "America/New_York"), edge-derived — an engaged-hours proxy without precise geo. */
export function timezone(req: Request): string | null {
	return cfLabel(req.cf?.timezone);
}

/** The visitor's network: the autonomous-system org (ISP or company — enables cookieless B2B), or null.
 * Datacenter/hosting ASNs read the same way; residential-vs-datacenter is classified downstream. */
export function network(req: Request): string | null {
	return cfLabel(req.cf?.asOrganization);
}

/** Connection-quality tier from the edge TCP round-trip (a dimension Umami cannot offer at all): fast
 * (<100ms), moderate (<300ms), or slow. `null` when the edge did not measure it. */
export function connectionTier(rtt: number | undefined): 'fast' | 'moderate' | 'slow' | null {
	if (typeof rtt !== 'number' || !Number.isFinite(rtt) || rtt <= 0) return null;
	if (rtt < 100) return 'fast';
	if (rtt < 300) return 'moderate';
	return 'slow';
}

/** Connection tier for a request (reads `clientTcpRtt`). */
export function connection(req: Request): 'fast' | 'moderate' | 'slow' | null {
	const rtt = req.cf?.clientTcpRtt;
	return connectionTier(typeof rtt === 'number' ? rtt : undefined);
}

// ── Browser / OS / form-factor (User-Agent Client Hints first, UA string only as a fallback) ─────────

/** The significant browser brand from a `Sec-CH-UA` header, ignoring the intentional "GREASE" brand and
 * bare "Chromium" when a more specific brand is present. Returns null when no usable brand is found. */
export function brandFromSecChUa(secChUa: string | null): string | null {
	if (!secChUa) return null;
	const brands: string[] = [];
	for (const m of secChUa.matchAll(/"([^"]+)"\s*;\s*v="[^"]*"/g)) {
		const brand = m[1]?.trim();
		if (!brand) continue;
		if (/not.*brand/i.test(brand)) continue; // GREASE / "Not;A=Brand"
		brands.push(brand);
	}
	// Prefer a specific brand over generic Chromium.
	const specific = brands.find((b) => !/^chromium$/i.test(b));
	return specific ?? brands[0] ?? null;
}

/** Coarse browser family, UA-CH first then a UA-string fallback (families only — never a version, which
 * is a fingerprint bit). Chromium UA-CH is accurate and future-proof as UA strings freeze. */
export function browserFamily(secChUa: string | null, userAgent: string): string {
	const brand = brandFromSecChUa(secChUa);
	if (brand) {
		if (/edge/i.test(brand)) return 'Edge';
		if (/opera|opr/i.test(brand)) return 'Opera';
		if (/brave/i.test(brand)) return 'Brave';
		if (/google chrome|chrome/i.test(brand)) return 'Chrome';
		if (/chromium/i.test(brand)) return 'Chromium';
		return brand;
	}
	if (/\bEdg[eA]?\//.test(userAgent)) return 'Edge';
	if (/\bOPR\/|\bOpera\b/.test(userAgent)) return 'Opera';
	if (/\bFirefox\//.test(userAgent)) return 'Firefox';
	if (/\bChrome\//.test(userAgent)) return 'Chrome';
	if (/\bSafari\//.test(userAgent) && !/\bChrome\//.test(userAgent)) return 'Safari';
	return 'Other';
}

/** Coarse OS family, from `Sec-CH-UA-Platform` (already a bare family) then a UA-string fallback. */
export function osFamily(platformHint: string | null, userAgent: string): string {
	const hint = platformHint?.replace(/"/g, '').trim();
	if (hint && hint.toLowerCase() !== 'unknown') {
		if (/macos/i.test(hint)) return 'macOS';
		if (/chrome os|chromium os/i.test(hint)) return 'Chrome OS';
		return hint; // "Windows", "Android", "iOS", "Linux"
	}
	if (/\bWindows\b/.test(userAgent)) return 'Windows';
	if (/\biPhone\b|\biPad\b|\biOS\b/.test(userAgent)) return 'iOS';
	if (/\bMac OS X\b|\bMacintosh\b/.test(userAgent)) return 'macOS';
	if (/\bAndroid\b/.test(userAgent)) return 'Android';
	if (/\bCrOS\b/.test(userAgent)) return 'Chrome OS';
	if (/\bLinux\b/.test(userAgent)) return 'Linux';
	return 'Other';
}

/** Form factor from the low-entropy `Sec-CH-UA-Mobile` hint (`?1`/`?0`), falling back to the UA device
 * class (so tablets, which the mobile hint lumps in with desktop, are still separated). */
export function formFactor(
	mobileHint: string | null,
	userAgent: string,
): 'mobile' | 'tablet' | 'desktop' {
	const dev = device(userAgent);
	if (dev === 'tablet') return 'tablet';
	if (mobileHint === '?1') return 'mobile';
	if (mobileHint === '?0') return 'desktop';
	return dev;
}

/** Primary language subtag only (e.g. `en` from `en-US,en;q=0.9,de;q=0.8`) — the full ordered list is a
 * strong fingerprint, so region, quality values, and secondary languages are discarded. */
export function primaryLanguage(acceptLanguage: string | null): string | null {
	if (!acceptLanguage) return null;
	const first = acceptLanguage.split(',')[0]?.trim();
	if (!first || first === '*') return null;
	const tag = first.split(';')[0]?.trim().split('-')[0]?.toLowerCase();
	return tag && /^[a-z]{2,3}$/.test(tag) ? tag : null;
}

// ── On-device coarsened values (the tracker buckets these before they leave the browser, so the raw
//    high-entropy values — exact resolution, precise DPR — are never received) ────────────────────────

const SCREEN_TIERS = new Set(['phone', 'tablet', 'laptop', 'desktop', 'ultrawide']);
const ORIENTATIONS = new Set(['portrait', 'landscape']);
const DPR_CLASSES = new Set(['1x', '2x', '3x']);

/** Validate a tracker-supplied value against an allowlist, returning `null` for anything unexpected. */
function oneOf(set: Set<string>, value: unknown): string | null {
	return typeof value === 'string' && set.has(value) ? value : null;
}

/** The width tier the tracker bucketed the viewport into (never the raw pixel width). */
export function screenTier(value: unknown): string | null {
	return oneOf(SCREEN_TIERS, value);
}
/** Portrait/landscape, bucketed on-device. */
export function orientation(value: unknown): string | null {
	return oneOf(ORIENTATIONS, value);
}
/** Device-pixel-ratio class (1x/2x/3x), bucketed on-device from the raw DPR. */
export function dprClass(value: unknown): string | null {
	return oneOf(DPR_CLASSES, value);
}

/** All request-derived (header/`cf`) segmentation dimensions in one call, for the ingest path. Screen
 * tier / orientation / DPR are NOT here — they come coarsened in the beacon body, validated separately. */
export function segmentation(req: Request): {
	region: string | null;
	city: string | null;
	timezone: string | null;
	network: string | null;
	connection: 'fast' | 'moderate' | 'slow' | null;
	browser: string;
	os: string;
	formFactor: 'mobile' | 'tablet' | 'desktop';
	language: string | null;
} {
	const ua = req.headers.get('user-agent') ?? '';
	return {
		region: region(req),
		city: city(req),
		timezone: timezone(req),
		network: network(req),
		connection: connection(req),
		browser: browserFamily(req.headers.get('sec-ch-ua'), ua),
		os: osFamily(req.headers.get('sec-ch-ua-platform'), ua),
		formFactor: formFactor(req.headers.get('sec-ch-ua-mobile'), ua),
		language: primaryLanguage(req.headers.get('accept-language')),
	};
}
