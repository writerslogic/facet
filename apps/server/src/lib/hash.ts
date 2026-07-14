// Privacy-safe visitor hashing: SHA-256(ip ⧊ user_agent ⧊ daily_salt ⧊ site_id) with ⧊ =
// HASH_DELIMITER, in that exact field order. Raw IPs never leave this function or reach a log.

import { HASH_DELIMITER } from './constants.js';
import { sha256Hex } from './crypto.js';

/** Compute the daily privacy-safe visitor hash. Returns 64 lowercase hex chars. */
export async function visitorHash(
	ip: string,
	userAgent: string,
	dailySalt: string,
	siteId: string,
): Promise<string> {
	return sha256Hex([ip, userAgent, dailySalt, siteId].join(HASH_DELIMITER));
}
