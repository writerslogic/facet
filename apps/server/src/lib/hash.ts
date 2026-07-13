// Privacy-safe visitor hashing: SHA-256(ip + user_agent + daily_salt + site_id).
// Raw IPs never leave this function. Real implementation lands in T008.

/** Compute the daily privacy-safe visitor hash. Returns lowercase hex. */
export async function visitorHash(
	_ip: string,
	_userAgent: string,
	_dailySalt: string,
	_siteId: string,
): Promise<string> {
	return '';
}
