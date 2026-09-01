export const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch', 'display']);

export const SOCIAL_HOSTS = new Set([
	'facebook.com',
	'm.facebook.com',
	'twitter.com',
	'x.com',
	't.co',
	'linkedin.com',
	'lnkd.in',
	'instagram.com',
	'youtube.com',
	'reddit.com',
	'pinterest.com',
	'tiktok.com',
]);

export const SEARCH_PREFIXES = [
	'google.',
	'bing.',
	'duckduckgo.',
	'yahoo.',
	'yandex.',
	'baidu.',
	'ecosia.',
];

export type Channel = 'paid' | 'email' | 'social' | 'organic' | 'direct' | 'internal' | 'referral';

export function parseUtm(search: string): {
	source: string | null;
	medium: string | null;
	campaign: string | null;
} {
	const params = new URLSearchParams(search);
	return {
		source: params.get('utm_source'),
		medium: params.get('utm_medium'),
		campaign: params.get('utm_campaign'),
	};
}

function extractHostname(url: string): string | null {
	if (!url) return null;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** Strips a leading `www.` so a hostname comparison doesn't split on that one label — the same
 * site (or the same known host) reached with or without the `www` subdomain is still the same
 * site or host. */
function stripWww(hostname: string): string {
	return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

/** Second-level labels that belong to a public suffix rather than to a registrant, so
 * `google.co.uk` is the search engine while `google.abc.com` is somebody else's subdomain. */
const PUBLIC_SECOND_LEVELS = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu']);

/** IMPORTANT: the engine label MUST sit at the registrable domain, never merely at the start of
 * the hostname. The referrer is attacker-supplied, so a prefix test scores the referrer-spam shape
 * `google.spam.example` as organic; anchoring on labels also stops `news.google.com` and
 * `search.yahoo.com` from falling through to referral. */
function isSearchHost(hostname: string): boolean {
	const labels = hostname.split('.');
	return SEARCH_PREFIXES.some((prefix) => {
		const i = labels.lastIndexOf(prefix.slice(0, -1));
		if (i < 0 || i > labels.length - 2) return false;
		const [sld, tld, extra] = labels.slice(i + 1);
		if (sld === undefined || extra !== undefined) return false;
		return tld === undefined || (PUBLIC_SECOND_LEVELS.has(sld) && tld.length <= 3);
	});
}

/** Suffix match against a whitelist cannot be spoofed — `facebook.com.evil.example` does not end
 * in `.facebook.com` — and it keeps `old.reddit.com` or `web.facebook.com` on the same host. */
function isSocialHost(hostname: string): boolean {
	const host = stripWww(hostname);
	if (SOCIAL_HOSTS.has(host)) return true;
	for (const known of SOCIAL_HOSTS) {
		if (host.endsWith(`.${known}`)) return true;
	}
	return false;
}

export function classifyChannel(args: {
	referrer: string;
	utm: { source: string | null; medium: string | null; campaign: string | null };
	siteHostname: string;
}): Channel {
	const { referrer, utm, siteHostname } = args;
	const medium = utm.medium?.toLowerCase() ?? null;
	const source = utm.source?.toLowerCase() ?? null;

	if (medium !== null && PAID_MEDIUMS.has(medium)) return 'paid';
	if (medium === 'email' || source === 'newsletter') return 'email';

	const referrerHost = extractHostname(referrer);

	if (medium === 'social' || (referrerHost !== null && isSocialHost(referrerHost)))
		return 'social';
	if (referrerHost !== null && isSearchHost(referrerHost)) return 'organic';
	if (!referrer || referrer.trim() === '') return 'direct';
	if (referrerHost !== null && stripWww(referrerHost) === stripWww(siteHostname.toLowerCase()))
		return 'internal';
	return 'referral';
}
