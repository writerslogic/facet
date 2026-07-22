// Request metadata extraction: client IP, country, and device class, all derived from Cloudflare
// request headers / `cf` properties. The raw IP is read here but never stored or logged.

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
	if (/\b(mobi|android|iphone)\b/i.test(userAgent)) {
		return 'mobile';
	}
	return 'desktop';
}
