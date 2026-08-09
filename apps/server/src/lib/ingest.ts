// Shared ingest pipeline used by both the public browser beacon (POST /api/collect) and the
// authenticated first-party server events endpoint (POST /api/event). Drops bots, derives the
// privacy-safe visitor hash, classifies the traffic channel, and writes a raw event + session.
// The raw IP is used only to derive the hash and is never stored, logged, or returned.

import type { EventProps } from '@facet/shared';
import { type NewEvent, type NewSession, persistEvents } from '../db/queries.js';
import type { Env } from '../env.js';
import { writeEvent } from './ae.js';
import { isBot } from './bots.js';
import { classifyChannel } from './channel.js';
import { findActiveConsent } from './consent.js';
import { visitorHash } from './hash.js';
import {
	type IdentityPolicy,
	deriveVisitorHash,
	getScopedSalt,
	resolvePolicy,
	windowEndMs,
	windowKey,
} from './identity.js';
import { dayKey, getDailySalt } from './salt.js';

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
	/** Coarse segmentation dimensions (edge-derived + UA-CH + on-device-bucketed); all optional/null. */
	segmentation?: {
		browser?: string | null;
		os?: string | null;
		formFactor?: string | null;
		region?: string | null;
		city?: string | null;
		timezone?: string | null;
		network?: string | null;
		connection?: string | null;
		language?: string | null;
		screenTier?: string | null;
		orientation?: string | null;
		dprClass?: string | null;
	};
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

/** The anonymous Tier-0 day hash — the fallback for a GPC visitor, a zero-config site, and any
 * elevated event that cannot or does not qualify for elevation. Never dropped. */
function anonymousFallback(env: Env, input: IngestInput, dk: string): Promise<string> {
	return getDailySalt(env, dk, input.now).then((salt) =>
		visitorHash(input.ip, input.ua, salt, input.siteId),
	);
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
	if (policy.tier === 'anonymous' || input.gpc) {
		return anonymousFallback(env, input, dk);
	}
	const uid = policy.tier === 'identified' && input.consent === true ? (input.uid ?? null) : null;
	// An identified event with no uid can never match a consent record (those are always uid-derived,
	// per `buildPreimage`'s invariant), so it skips straight to Tier-0 without minting a scoped salt
	// it would never use.
	if (policy.tier === 'identified' && !uid) {
		return anonymousFallback(env, input, dk);
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
	return anonymousFallback(env, input, dk);
}

/** A fully-derived, IP-free event ready to persist — the queue message shape. The raw IP is consumed
 * into `row.visitorHash` during derivation and never appears here, so it is never queued. */
export interface DerivedEvent {
	id: string;
	row: NewEvent;
	session: NewSession;
}

/** Derive a complete event row + session from a request-time input — bot drop, privacy-safe visitor
 * hash, channel classification, segmentation — WITHOUT touching D1, so the result is safe to enqueue
 * and persist later. Returns null for bots (dropped). This is the CPU/derivation half of ingest; the
 * D1 writes live in `persistDerived`, which the beacon hot path defers to the queue consumer. */
export async function deriveEvent(env: Env, input: IngestInput): Promise<DerivedEvent | null> {
	if (isBot(input.ua)) {
		return null;
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
	// Ecommerce: lift a finite numeric `props.revenue` into the typed `value` column (with `currency`)
	// so revenue aggregates SUM/AVG efficiently. Non-numeric/absent revenue leaves both null.
	const revenue = input.props?.revenue;
	const value = typeof revenue === 'number' && Number.isFinite(revenue) ? revenue : null;
	const cur = input.props?.currency;
	const currency =
		value !== null && typeof cur === 'string' ? cur.slice(0, 3).toUpperCase() : null;
	const row: NewEvent = {
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
		browser: input.segmentation?.browser ?? null,
		os: input.segmentation?.os ?? null,
		formFactor: input.segmentation?.formFactor ?? null,
		region: input.segmentation?.region ?? null,
		city: input.segmentation?.city ?? null,
		timezone: input.segmentation?.timezone ?? null,
		network: input.segmentation?.network ?? null,
		connection: input.segmentation?.connection ?? null,
		language: input.segmentation?.language ?? null,
		screenTier: input.segmentation?.screenTier ?? null,
		orientation: input.segmentation?.orientation ?? null,
		dprClass: input.segmentation?.dprClass ?? null,
		value,
		currency,
	};
	// Mirror into the columnar store HERE rather than alongside the D1 write. Derivation runs exactly
	// once per accepted event, whereas the queue redelivers a batch at-least-once and Analytics Engine
	// has no idempotent insert — writing on the persist path would inflate every retried batch. This is
	// a fire-and-forget, non-blocking sink that no-ops when the binding is absent, so `deriveEvent`
	// still touches no database and its result is still safe to enqueue.
	writeEvent(env, row);
	// The id is minted HERE (not at insert) so an at-least-once queue redelivery re-inserts the same id
	// as a no-op — the persist path is idempotent, so a retry can never duplicate the event.
	return {
		id: crypto.randomUUID(),
		row,
		session: {
			siteId: input.siteId,
			visitorHash: vh,
			dayKey: dk,
			firstSeen: input.now,
		},
	};
}

/** Persist derived events + their sessions (batched, idempotent). The queue consumer calls this for a
 * whole batch; the synchronous fallback calls it with a single event. */
export async function persistDerived(env: Env, items: DerivedEvent[]): Promise<void> {
	await persistEvents(env, items);
}

/** Run the ingest pipeline for one event synchronously (derive + persist). Returns whether a row was
 * written. Used by the authenticated /api/event route and the beacon's fallback when no queue is bound;
 * the high-volume beacon path instead enqueues `deriveEvent`'s result. */
export async function ingestEvent(env: Env, input: IngestInput): Promise<{ inserted: boolean }> {
	const derived = await deriveEvent(env, input);
	if (!derived) {
		return { inserted: false };
	}
	await persistDerived(env, [derived]);
	return { inserted: true };
}
