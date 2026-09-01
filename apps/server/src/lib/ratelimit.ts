// Rate-limit middleware backed by the Cloudflare native RATE_LIMITER binding. When the binding is
// absent (e.g. a unit test without it) the limiter is a no-op. A denied request becomes a
// `rate_limited` ApiError (429) carrying `Retry-After: 60`, rendered by the app's error handler.

import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.js';
import { tooManyRequests } from './http.js';
import { createLogger } from './log.js';

const log = createLogger({ component: 'ratelimit' });

/** Build rate-limit middleware keyed by `keyFn` (client IP for the beacon, site id for events). */
export function rateLimit(keyFn: (c: Context<AppEnv>) => string): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		await enforceRateLimit(c, keyFn(c));
		return next();
	};
}

/** Charge an additional bucket from inside a validated handler (for example a body-derived site id). */
export async function enforceRateLimit(c: Context<AppEnv>, key: string): Promise<void> {
	const rl = c.env.RATE_LIMITER;
	if (!rl) return;
	let allowed: boolean;
	try {
		allowed = (await rl.limit({ key })).success;
	} catch (error) {
		// A limiter-service failure used to unwind as an unhandled error, so every beacon behind it
		// answered 500 and its event was lost. Fail open, matching the unbound-binding path above.
		// IMPORTANT: `key` embeds the raw client IP on the public routes, so it never reaches the log.
		log.error('rate_limit_unavailable', error);
		return;
	}
	if (!allowed) {
		c.header('Retry-After', '60');
		throw tooManyRequests();
	}
}
