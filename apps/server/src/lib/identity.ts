// Identity spectrum (U2) — the salt-window derivation core. One axis, linkability, chosen per site:
//   • anonymous  (DEFAULT) — ip|ua|salt|siteId, day window. Byte-for-byte identical to the legacy
//     `visitorHash` + `getDailySalt` path; a site with no config behaves exactly as before.
//   • pseudonymous          — ip|ua|salt|siteId, window ∈ day|week|month (stable within, unlinkable
//     across, exactly like the daily rotation but at a chosen granularity).
//   • identified            — uid:<uid>|salt|siteId, window ∈ day|week|month. The `uid:` namespace
//     can never collide with an anonymous pre-image; siteId in every pre-image blocks any cross-site
//     super-cookie. There is NO `never` window: linkage is always bounded by retention.
//
// This module is the derivation math only (pure given a salt). Salt storage, policy resolution, and
// consent enforcement live alongside it but are separated so these functions stay trivially testable
// and provably a superset of the day path (`windowKey('day', t) === dayKey(t)`).

import type { IdentityTier, SaltWindow } from '@facet/shared';
import { HASH_DELIMITER } from './constants.js';
import { sha256Hex } from './crypto.js';
import { dayKey } from './salt.js';

const DAY_MS = 86_400_000;

/** ISO-8601 week key `GGGG-Www` using the ISO week-NUMBERING year (not the calendar year), so the
 * days around a year boundary that belong to the same ISO week share one key. Computed via the
 * Thursday rule: the ISO year of a week is the calendar year of that week's Thursday. */
export function isoWeekKey(nowMs: number): string {
	const date = new Date(nowMs);
	// UTC midnight of the given day, then shift to this ISO week's Thursday.
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
	d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this week
	const isoYear = d.getUTCFullYear();
	// Thursday of ISO week 1 is the Thursday of the week containing Jan 4.
	const week1Thursday = new Date(Date.UTC(isoYear, 0, 4));
	const week1DayNum = (week1Thursday.getUTCDay() + 6) % 7;
	week1Thursday.setUTCDate(week1Thursday.getUTCDate() - week1DayNum + 3);
	const week = 1 + Math.round((d.getTime() - week1Thursday.getTime()) / (7 * DAY_MS));
	return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** UTC `YYYY-MM` month key. */
export function monthKey(nowMs: number): string {
	const d = new Date(nowMs);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The window key for a salt window at a timestamp. `day` delegates to the existing `dayKey`, so the
 * generalization is a pure superset: `windowKey('day', t) === dayKey(t)` for every `t`. */
export function windowKey(window: SaltWindow, nowMs: number): string {
	switch (window) {
		case 'day':
			return dayKey(nowMs);
		case 'week':
			return isoWeekKey(nowMs);
		case 'month':
			return monthKey(nowMs);
	}
}

/** Transient, never-stored inputs to a visitor-hash derivation. `uid` is honored only at Tier 2. */
export interface DeriveInputs {
	ip: string;
	ua: string;
	uid?: string | null;
}

/** Build the hash pre-image for a tier. Tier < identified is the legacy `ip|ua|salt|siteId`; the
 * identified pre-image is `uid:<uid>|salt|siteId` — the `uid:` prefix guarantees it can never equal
 * an anonymous pre-image (no forged collision between an identified user and an anonymous visitor). */
export function buildPreimage(
	tier: IdentityTier,
	inputs: DeriveInputs,
	salt: string,
	siteId: string,
): string {
	if (tier === 'identified' && inputs.uid) {
		return [`uid:${inputs.uid}`, salt, siteId].join(HASH_DELIMITER);
	}
	return [inputs.ip, inputs.ua, salt, siteId].join(HASH_DELIMITER);
}

/** Derive the 64-hex visitor hash for a tier. For `anonymous`/`pseudonymous` this is identical to
 * `visitorHash(ip, ua, salt, siteId)`, so the Tier-0 path is a proven no-op. */
export function deriveVisitorHash(
	tier: IdentityTier,
	inputs: DeriveInputs,
	salt: string,
	siteId: string,
): Promise<string> {
	return sha256Hex(buildPreimage(tier, inputs, salt, siteId));
}
