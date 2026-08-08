// Browser CSRF guard for cookie-authenticated mutations. Authorization-header clients are not
// affected; browsers supply Origin and Fetch Metadata on cross-site unsafe requests.

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.js';
import { ApiError } from './http.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (SAFE_METHODS.has(c.req.method)) return next();
	if (c.req.header('sec-fetch-site') === 'cross-site') {
		throw new ApiError('csrf_rejected', 403);
	}
	const origin = c.req.header('origin');
	if (origin) {
		let expected: string;
		try {
			expected = new URL(c.req.url).origin;
		} catch {
			throw new ApiError('csrf_rejected', 403);
		}
		if (origin !== expected) throw new ApiError('csrf_rejected', 403);
	}
	return next();
};
