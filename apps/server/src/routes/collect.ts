// POST /api/collect — public, rate-limited beacon. Rate-limits by IP, validates the payload,
// drops bot traffic, hashes the visitor privacy-safely, and writes a raw event + session upsert.
// The raw IP is used only to derive the hash; it is never stored, logged, or returned.

import { CollectPayloadSchema } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { isGpcOptOut } from '../lib/gpc.js';
import { validationErrorHook } from '../lib/http.js';
import { submitEvent } from '../lib/ingest.js';
import { enforceRateLimit, rateLimit } from '../lib/ratelimit.js';
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

function normalizedHostname(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, '');
}

function domainAllows(configured: string, candidate: string): boolean {
	const domain = normalizedHostname(configured.replace(/^https?:\/\//, '').split('/')[0] ?? '');
	const hostname = normalizedHostname(candidate);
	return domain.length > 0 && (hostname === domain || hostname.endsWith(`.${domain}`));
}

/** Reject unknown sites and cross-domain beacons without revealing which site ids exist. */
async function validCollectionTarget(
	c: Context<AppEnv>,
	siteId: string,
	hostname: string,
): Promise<boolean> {
	if (c.env.COLLECT_VALIDATE_SITE === 'false') return true;
	const site = await db(c.env)
		.select({ domain: schema.sites.domain })
		.from(schema.sites)
		.where(eq(schema.sites.id, siteId))
		.get();
	if (!site || !domainAllows(site.domain, hostname)) return false;
	const origin = c.req.header('origin');
	if (!origin) return true;
	try {
		return normalizedHostname(new URL(origin).hostname) === normalizedHostname(hostname);
	} catch {
		return false;
	}
}

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
		// A second, site-scoped bucket stops distributed sources from bypassing the IP bucket and
		// exhausting one site's storage/quota. It runs after validation so the key is canonical.
		await enforceRateLimit(c, `collect-site:${body.site_id}`);
		if (!(await validCollectionTarget(c, body.site_id, body.hostname))) {
			// A uniform accepted response prevents the public endpoint from becoming a site-id oracle.
			return c.body(null, 202);
		}
		const ua = c.req.header('user-agent') ?? '';
		// Segmentation dimensions: geo/network/browser/os/language from the edge + low-entropy UA client
		// hints; screen tier / orientation / DPR arrive already bucketed on-device in the beacon body.
		const seg = segmentation(c.req.raw);
		// The public beacon carries no trusted identity, so it can only ever produce a Tier 0/1 hash.
		const input = {
			eventId: body.event_id,
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
		// Hot path: consume the raw IP during derivation, then queue only the privacy-safe row. Minimal
		// deployments and queue outages fall back to an idempotent synchronous D1 write.
		await submitEvent(c.env, input);
		// Advertise the low-entropy UA client hints so browsers keep sending them to this endpoint.
		c.header('Accept-CH', 'Sec-CH-UA, Sec-CH-UA-Platform, Sec-CH-UA-Mobile');
		return c.body(null, 202);
	},
);
