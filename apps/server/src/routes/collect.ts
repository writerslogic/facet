// POST /api/collect — public, rate-limited beacon. Rate-limits by IP, validates the payload,
// drops bot traffic, hashes the visitor privacy-safely, and writes a raw event + session upsert.
// The raw IP is used only to derive the hash; it is never stored, logged, or returned.

import { CollectPayloadSchema } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { isGpcOptOut } from '../lib/gpc.js';
import { validationErrorHook } from '../lib/http.js';
import { deriveEvent, ingestEvent } from '../lib/ingest.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
	clientIp,
	country,
	device,
	dprClass,
	orientation,
	screenTier,
	segmentation,
} from '../lib/request-meta.js';

export const collectRoute = new Hono<AppEnv>();

collectRoute.post(
	'/',
	rateLimit((c) => `collect:${clientIp(c.req.raw)}`),
	vValidator('json', CollectPayloadSchema, validationErrorHook),
	async (c) => {
		// GPC (Sec-GPC: 1) no longer drops the event: an anonymous, cookieless pageview carries no personal
		// data, so it is still counted so total traffic stays accurate. GPC instead forces the anonymous
		// Tier-0 hash downstream (a GPC visitor is never identity-elevated). A deliberate client opt-out
		// sends no beacon at all, so it never reaches here.
		const gpc = isGpcOptOut(c.req.raw);
		const body = c.req.valid('json');
		const ua = c.req.header('user-agent') ?? '';
		// Segmentation dimensions: geo/network/browser/os/language from the edge + low-entropy UA client
		// hints; screen tier / orientation / DPR arrive already bucketed on-device in the beacon body.
		const seg = segmentation(c.req.raw);
		// The public beacon carries no trusted identity, so it can only ever produce a Tier 0/1 hash.
		const input = {
			siteId: body.site_id,
			ip: clientIp(c.req.raw),
			ua,
			hostname: body.hostname,
			path: body.path,
			referrer: body.referrer,
			name: body.name ?? null,
			props: body.props ?? null,
			utm: body.utm ?? null,
			country: country(c.req.raw),
			device: device(ua),
			segmentation: {
				...seg,
				screenTier: screenTier(body.screen),
				orientation: orientation(body.orientation),
				dprClass: dprClass(body.dpr),
			},
			now: Date.now(),
			gpc,
			url: new URL(c.req.url),
			uid: null,
			consent: false,
		};
		// Hot path: derive the IP-free event now (the raw IP goes into the hash and is discarded here) and
		// enqueue it, so the beacon returns without waiting on any D1 write — a consumer batches the writes.
		// Falls back to a synchronous write only when no queue is bound (tests / minimal deployments).
		if (c.env.INGEST_QUEUE) {
			const derived = await deriveEvent(c.env, input);
			if (derived) await c.env.INGEST_QUEUE.send(derived);
		} else {
			await ingestEvent(c.env, input);
		}
		// Advertise the low-entropy UA client hints so browsers keep sending them to this endpoint.
		c.header('Accept-CH', 'Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Mobile');
		return c.body(null, 202);
	},
);
