// POST /api/collect — public, rate-limited beacon. Rate-limits by IP, validates the payload,
// drops bot traffic, hashes the visitor privacy-safely, and writes a raw event + session upsert.
// The raw IP is used only to derive the hash; it is never stored, logged, or returned.

import { CollectPayloadSchema } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { isGpcOptOut } from '../lib/gpc.js';
import { validationErrorHook } from '../lib/http.js';
import { ingestEvent } from '../lib/ingest.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp, country, device } from '../lib/request-meta.js';

export const collectRoute = new Hono<AppEnv>();

collectRoute.post(
	'/',
	rateLimit((c) => `collect:${clientIp(c.req.raw)}`),
	vValidator('json', CollectPayloadSchema, validationErrorHook),
	async (c) => {
		// GPC opt-out: drop silently (202) before any hashing or write, like a client opt-out.
		if (isGpcOptOut(c.req.raw)) {
			return c.body(null, 202);
		}
		const body = c.req.valid('json');
		const ua = c.req.header('user-agent') ?? '';
		await ingestEvent(c.env, {
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
			now: Date.now(),
		});
		return c.body(null, 202);
	},
);
