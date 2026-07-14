// Rate-limit middleware backed by the Cloudflare native RATE_LIMITER binding. When the binding is
// absent (e.g. a unit test without it) the limiter is a no-op. A denied request becomes a
// `rate_limited` ApiError (429) carrying `Retry-After: 60`, rendered by the app's error handler.

import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env.js';
import { ApiError } from './http.js';

/** Build rate-limit middleware keyed by `keyFn` (e.g. client IP for the public beacon). */
export function rateLimit(
	keyFn: (c: Context<{ Bindings: Env }>) => string,
): MiddlewareHandler<{ Bindings: Env }> {
	return async (c, next) => {
		const rl = c.env.RATE_LIMITER;
		if (!rl) {
			return next();
		}
		const { success } = await rl.limit({ key: keyFn(c) });
		if (!success) {
			c.header('Retry-After', '60');
			throw new ApiError('rate_limited', 429);
		}
		return next();
	};
}
