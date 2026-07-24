// Shared ingest pipeline used by both the public browser beacon (POST /api/collect) and the
// authenticated first-party server events endpoint (POST /api/event). Drops bots, derives the
// privacy-safe visitor hash, classifies the traffic channel, and writes a raw event + session.
// The raw IP is used only to derive the hash and is never stored, logged, or returned.

import type { EventProps } from "@facet/shared";
import { insertEvent, upsertSession } from "../db/queries.js";
import type { Env } from "../env.js";
import { isBot } from "./bots.js";
import { classifyChannel } from "./channel.js";
import { findActiveConsent } from "./consent.js";
import { visitorHash } from "./hash.js";
import {
	type IdentityPolicy,
	deriveVisitorHash,
	getScopedSalt,
	resolvePolicy,
	windowEndMs,
	windowKey,
} from "./identity.js";
import { dayKey, getDailySalt } from "./salt.js";

export interface IngestInput {
	siteId: string;
	/** Raw IP, used only to derive the visitor hash. Never stored, logged, or returned. */
	ip: string;
	/** User-agent, used for bot detection, device, and the visitor hash. */
	ua: string;
	hostname: string;
	path: string;
	referrer: string;
	name: string | null;
	props: EventProps | null;
	utm: { source?: string; medium?: string; campaign?: string } | null;
	country: string | null;
	device: string | null;
	now: number;
	/** The visitor's GPC signal. Enforced HERE (not only at the route) so every caller of ingestEvent
	 * treats a GPC visitor the same by construction: still counted, but forced to the anonymous Tier-0
	 * hash (never identity-elevated) — a new write path can't forget it. */
	gpc: boolean;
	/** Deployment request URL, for the did:web issuer binding when verifying consent. */
	url: URL;
	/** Tier-2 transient inputs, honored only for an `identified` site with per-event `consent`. Like
	 * `ip`, `uid` never leaves the derivation — never stored, logged, or returned. */
	uid?: string | null;
	consent?: boolean;
}

/** Derive the visitor hash under the site's identity policy. Tier 0 is the legacy day-salt path,
 * byte-for-byte unchanged. Above Tier 0, elevation happens ONLY when an active, deployment-key-signed,
 * context-bound consent record exists for the derived per-window hash; otherwise the event silently
 * downgrades to the anonymous Tier-0 hash. A GPC signal forces the anonymous Tier-0 hash outright, so a
 * GPC visitor is counted but never identity-elevated. Only an elevated site (explicitly opted in) ever
 * touches `identity_salts`. */
async function deriveForIngest(
	env: Env,
	input: IngestInput,
	policy: IdentityPolicy,
	dk: string,
): Promise<string> {
	if (policy.tier === "anonymous" || input.gpc) {
		const salt = await getDailySalt(env, dk, input.now);
		return visitorHash(input.ip, input.ua, salt, input.siteId);
	}
	const wk = windowKey(policy.window, input.now);
	const scope = `${input.siteId}:${policy.window}:${wk}`;
	const salt = await getScopedSalt(
		env,
		scope,
		policy.window,
		windowEndMs(policy.window, input.now),
		input.now,
	);
	const uid =
		policy.tier === "identified" && input.consent === true
			? (input.uid ?? null)
			: null;
	const vh = await deriveVisitorHash(
		policy.tier,
		{ ip: input.ip, ua: input.ua, uid },
		salt,
		input.siteId,
	);
	const consent = await findActiveConsent(env, input.url, {
		siteId: input.siteId,
		visitorHash: vh,
		tier: policy.tier,
		windowKey: wk,
		now: input.now,
	});
	if (consent) return vh;
	// Downgrade this event to the anonymous Tier-0 day hash. Never dropped.
	const daySalt = await getDailySalt(env, dk, input.now);
	return visitorHash(input.ip, input.ua, daySalt, input.siteId);
}

/** Run the ingest pipeline for one event. Returns whether a row was written. Bots are dropped; a GPC
 * visitor is still counted (anonymously — deriveForIngest forces the Tier-0 hash for them). */
export async function ingestEvent(
	env: Env,
	input: IngestInput,
): Promise<{ inserted: boolean }> {
	if (isBot(input.ua)) {
		return { inserted: false };
	}
	// Sessions always dedup on the calendar day, INDEPENDENT of the hash's salt window, so a wider
	// window never collides the (site, hash, day) session key or freezes first_seen.
	const dk = dayKey(input.now);
	const policy = await resolvePolicy(env, input.siteId);
	const vh = await deriveForIngest(env, input, policy, dk);
	const utm = {
		source: input.utm?.source ?? null,
		medium: input.utm?.medium ?? null,
		campaign: input.utm?.campaign ?? null,
	};
	const channel = classifyChannel({
		referrer: input.referrer,
		utm,
		siteHostname: input.hostname,
	});
	await insertEvent(env, {
		siteId: input.siteId,
		hostname: input.hostname,
		path: input.path,
		referrer: input.referrer,
		name: input.name,
		props: input.props,
		visitorHash: vh,
		country: input.country,
		device: input.device,
		createdAt: input.now,
		utmSource: utm.source,
		utmMedium: utm.medium,
		utmCampaign: utm.campaign,
		channel,
	});
	await upsertSession(env, input.siteId, vh, dk, input.now);
	return { inserted: true };
}
