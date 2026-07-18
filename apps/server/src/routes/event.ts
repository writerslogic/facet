// POST /api/event — first-party server-to-server event ingest, authenticated with an API key.
// Lets a customer's own backend send events (no client-side JS to block), so ad-blockers and
// content filters can't drop traffic. Same privacy model as the browser beacon: the raw IP is only
// used to derive the visitor hash and is never stored.

import { ServerEventSchema } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireApiKey } from '../lib/auth.js';
import { isGpcOptOut } from '../lib/gpc.js';
import { ingestEvent } from '../lib/ingest.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp, device } from '../lib/request-meta.js';

export const eventRoute = new Hono<AppEnv>();

// Auth runs first so only an authenticated caller ever consumes a bucket (an invalid key is rejected
// before rate limiting). The bucket is keyed per authenticated site, so a leaked/abused key is
// capped per customer and cannot drain another customer's quota.
eventRoute.post(
	'/',
	requireApiKey,
	rateLimit((c) => `event:${c.get('siteId')}`),
	vValidator('json', ServerEventSchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		// GPC opt-out: an authenticated backend still relays the visitor's signal; drop before write.
		if (isGpcOptOut(c.req.raw)) {
			return c.body(null, 202);
		}
		const body = c.req.valid('json');
		const ua = body.user_agent ?? '';
		await ingestEvent(c.env, {
			siteId: c.get('siteId'),
			ip: body.ip ?? clientIp(c.req.raw),
			ua,
			hostname: body.hostname,
			path: body.path,
			referrer: body.referrer ?? '',
			name: body.name ?? null,
			props: body.props ?? null,
			utm: body.utm ?? null,
			country: null,
			device: device(ua),
			now: Date.now(),
		});
		return c.body(null, 202);
	},
);
