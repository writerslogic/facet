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

/**
 * Matches a hostname against search-engine prefixes by registrable-domain.
 * Strips a leading `www.` so `www.google.com` matches the `google.` prefix,
 * then checks whether any label sequence begins with a known prefix.
 */
function isSearchHost(hostname: string): boolean {
	const normalized = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
	return SEARCH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
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

	if (medium === 'social' || (referrerHost !== null && SOCIAL_HOSTS.has(referrerHost)))
		return 'social';
	if (referrerHost !== null && isSearchHost(referrerHost)) return 'organic';
	if (!referrer || referrer.trim() === '') return 'direct';
	if (referrerHost !== null && referrerHost === siteHostname.toLowerCase()) return 'internal';
	return 'referral';
}
