// POST /api/collect — public, rate-limited beacon. Rate-limits by IP, validates the payload,
// drops bot traffic, hashes the visitor privacy-safely, and writes a raw event + session upsert.
// The raw IP is used only to derive the hash; it is never stored, logged, or returned.

import { CollectPayloadSchema } from '@countless/shared';
import { vValidator } from '@hono/valibot-validator';
import { Hono } from 'hono';
import { insertEvent, upsertSession } from '../db/queries.js';
import type { Env } from '../env.js';
import { isBot } from '../lib/bots.js';
import { visitorHash } from '../lib/hash.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp, country, device } from '../lib/request-meta.js';
import { dayKey, getDailySalt } from '../lib/salt.js';

export const collectRoute = new Hono<{ Bindings: Env }>();

collectRoute.post(
	'/',
	rateLimit((c) => clientIp(c.req.raw)),
	vValidator('json', CollectPayloadSchema, (result, c) => {
		if (!result.success) {
			return c.json({ error: 'validation_failed', issues: result.issues }, 400);
		}
	}),
	async (c) => {
		const body = c.req.valid('json');
		const now = Date.now();
		const ua = c.req.header('user-agent') ?? '';
		if (isBot(ua)) {
			return c.body(null, 202);
		}
		const ip = clientIp(c.req.raw);
		const dk = dayKey(now);
		const salt = await getDailySalt(c.env, dk, now);
		const vh = await visitorHash(ip, ua, salt, body.site_id);
		await insertEvent(c.env, {
			siteId: body.site_id,
			hostname: body.hostname,
			path: body.path,
			referrer: body.referrer,
			name: body.name ?? null,
			props: body.props ?? null,
			visitorHash: vh,
			country: country(c.req.raw),
			device: device(ua),
			createdAt: now,
		});
		await upsertSession(c.env, body.site_id, vh, dk, now);
		return c.body(null, 202);
	},
);
