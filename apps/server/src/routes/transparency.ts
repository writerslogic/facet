// Transparency-log endpoints over the MMR. `checkpoint` and `consistency` are public (they reveal
// only hashes about the aggregate dataset). `inclusion` is API-key + site-scoped: a rollup belongs to
// a site, so only that site's key can obtain its inclusion proof. All return `404`/`409` when the log
// is unconfigured or the requested state does not exist.

import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireApiScope } from '../lib/auth.js';
import { ApiError } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';
import { clientIp } from '../lib/request-meta.js';
import {
	consistencyBetween,
	inclusionForRollup,
	latestCheckpoint,
	rollupKey,
} from '../lib/transparency.js';

export const transparencyRoutes = new Hono<AppEnv>();

// Both public routes hit D1 on every anonymous request — the newest checkpoint row is a full
// signed-JSON blob, and a consistency proof adds a batched node read on top of it. Rate-limited like
// the attestation pair: one shared bucket per client, because it is the total anonymous read cost
// that has to be bounded, not each endpoint's share of it.
const publicLogLimit = rateLimit((c) => `transparency:${clientIp(c.req.raw)}`);

// Latest signed checkpoint (signed tree head).
transparencyRoutes.get('/checkpoint', publicLogLimit, async (c) => {
	const checkpoint = await latestCheckpoint(c.env);
	if (!checkpoint) return c.json({ error: 'no_checkpoint' }, 404);
	return c.json(checkpoint, 200, { 'content-type': 'application/json' });
});

// Inclusion proof for one of the caller's rollups. Requires site_id/hostname/bucket_start/interval.
transparencyRoutes.get('/inclusion', requireApiScope('read'), async (c) => {
	const siteId = c.req.query('site_id');
	if (siteId !== c.get('siteId')) throw new ApiError('site_mismatch', 403);
	const hostname = c.req.query('hostname');
	const bucketStart = Number(c.req.query('bucket_start'));
	const interval = c.req.query('interval') ?? 'hour';
	// IMPORTANT: the interval allowlist MUST stay in lockstep with `appendFinalizedRollups` — only
	// `hour` and `day` rollups are ever appended, so any other value names a leaf that cannot exist.
	// 253 is the DNS name limit `StatsQuerySchema` already applies to a caller-supplied hostname.
	if (
		!hostname ||
		hostname.length > 253 ||
		!Number.isInteger(bucketStart) ||
		(interval !== 'hour' && interval !== 'day')
	) {
		throw new ApiError(
			'bad_request',
			400,
			'hostname, integer bucket_start, and interval hour|day are required',
		);
	}
	const key = rollupKey({ siteId, hostname, bucketStart, interval });
	const result = await inclusionForRollup(c.env, key);
	if (!result) return c.json({ error: 'not_logged' }, 404);
	return c.json(
		{
			rollup_key: key,
			size: result.size,
			root: result.root,
			receipt: result.receipt,
		},
		200,
	);
});

// Consistency proof between two tree sizes (from <= to). Sizes come from prior checkpoints.
transparencyRoutes.get('/consistency', publicLogLimit, async (c) => {
	const from = Number(c.req.query('from'));
	const to = Number(c.req.query('to'));
	if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
		throw new ApiError('bad_request', 400, 'from and to must be integers with 0 <= from <= to');
	}
	const checkpoint = await latestCheckpoint(c.env);
	if (!checkpoint) return c.json({ error: 'no_checkpoint' }, 404);
	if (to > checkpoint.payload.size) {
		throw new ApiError('bad_request', 409, 'to exceeds the current tree size');
	}
	return c.json({ receipt: await consistencyBetween(c.env, from, to) }, 200);
});
