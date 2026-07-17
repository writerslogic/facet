// Shared ingest pipeline used by both the public browser beacon (POST /api/collect) and the
// authenticated first-party server events endpoint (POST /api/event). Drops bots, derives the
// privacy-safe visitor hash, classifies the traffic channel, and writes a raw event + session.
// The raw IP is used only to derive the hash and is never stored, logged, or returned.

import type { EventProps } from '@facet/shared';
import { insertEvent, upsertSession } from '../db/queries.js';
import type { Env } from '../env.js';
import { isBot } from './bots.js';
import { classifyChannel } from './channel.js';
import { visitorHash } from './hash.js';
import { dayKey, getDailySalt } from './salt.js';

export interface IngestInput {
	siteId: string;
	/** Raw IP, used only to derive the visitor hash. Never stored. */
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
}

/** Run the ingest pipeline for one event. Returns whether a row was written (bots are dropped). */
export async function ingestEvent(env: Env, input: IngestInput): Promise<{ inserted: boolean }> {
	if (isBot(input.ua)) {
		return { inserted: false };
	}
	const dk = dayKey(input.now);
	const salt = await getDailySalt(env, dk, input.now);
	const vh = await visitorHash(input.ip, input.ua, salt, input.siteId);
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
