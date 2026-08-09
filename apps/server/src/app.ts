// Hono app factory. Applies the canonical error envelope, scoped CORS + body limit for the
// public beacon, and a JSON 404, then mounts every sub-router from the route registry.

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './env.js';
import { COLLECT_MAX_BODY_BYTES, CORS_MAX_AGE } from './lib/constants.js';
import { ApiError, toErrorBody } from './lib/http.js';
import { ROUTES } from './routes/registry.js';

/** Add baseline security headers to a dashboard (non-API) response. Clones because ASSETS responses are
 * immutable. Sets framing/sniff/referrer protection only — no resource-restricting CSP directive, so
 * the SPA's own script/style/font loading is unaffected while clickjacking and MIME-sniffing are blocked. */
function withDashboardSecurityHeaders(res: Response): Response {
	const headers = new Headers(res.headers);
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('X-Frame-Options', 'DENY');
	headers.set(
		'Content-Security-Policy',
		[
			"default-src 'self'",
			"base-uri 'self'",
			"frame-ancestors 'none'",
			"form-action 'self'",
			"object-src 'none'",
			"script-src 'self'",
			// The dashboard uses runtime chart positioning and CSS custom properties.
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data:",
			"font-src 'self'",
			"connect-src 'self'",
		].join('; '),
	);
	headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
	headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}

export function createApp(): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	// MIME-sniffing is a browser behavior that applies to any response content type, not just the
	// dashboard's HTML/JS — `withDashboardSecurityHeaders` below only wrapped the SPA/asset catch-all,
	// leaving every /api/* JSON response with no protection at all. Applied first so it wraps every
	// route, including errors.
	app.use('*', async (c, next) => {
		await next();
		c.header('X-Content-Type-Options', 'nosniff');
	});

	// Public beacon: any origin may POST. The origin is reflected rather than sent as `*`
	// because navigator.sendBeacon() always issues the request in credentials mode, and a
	// credentialed request is rejected outright against a wildcard —
	// "Cannot use wildcard in Access-Control-Allow-Origin when credentials flag is true".
	// Every beacon from a site whose origin differs from this one was being dropped, so
	// cross-origin installs recorded nothing at all. Reflecting the origin and allowing
	// credentials is what makes a credentialed cross-origin POST legal; it grants nothing
	// extra here, since collection is cookieless.
	app.use(
		'/api/collect',
		cors({
			origin: (origin) => origin ?? '*',
			credentials: true,
			allowMethods: ['POST', 'OPTIONS'],
			allowHeaders: ['content-type'],
			maxAge: CORS_MAX_AGE,
		}),
	);

	// The tracker also reads its experiment assignments cross-origin. This carried no CORS
	// headers at all, so the browser blocked a 200 response and every install outside this
	// origin silently fell back to no experiments. Read-only and uncredentialed, so a
	// wildcard is both sufficient and correct here.
	app.use(
		'/api/experiments/active',
		cors({
			origin: '*',
			allowMethods: ['GET', 'OPTIONS'],
			allowHeaders: ['content-type'],
			maxAge: CORS_MAX_AGE,
		}),
	);

	// Same class of bug as /api/experiments/active: the tracker calls both flag endpoints
	// cross-origin (packages/client/src/flags.ts), and neither carried CORS headers, so a
	// preflight against /eval or a GET against /active was blocked and flags silently
	// resolved to their defaults on every real (cross-origin) install. Both are read-only
	// and uncredentialed (the caller supplies a body/query id, not a cookie), so a wildcard
	// is correct here too.
	app.use(
		'/api/flags/active',
		cors({
			origin: '*',
			allowMethods: ['GET', 'OPTIONS'],
			allowHeaders: ['content-type'],
			maxAge: CORS_MAX_AGE,
		}),
	);
	app.use(
		'/api/flags/eval',
		cors({
			origin: '*',
			allowMethods: ['POST', 'OPTIONS'],
			allowHeaders: ['content-type'],
			maxAge: CORS_MAX_AGE,
		}),
	);
	app.use(
		'/api/collect',
		bodyLimit({
			maxSize: COLLECT_MAX_BODY_BYTES,
			onError: () => {
				throw new ApiError('payload_too_large', 413);
			},
		}),
	);

	for (const { path, router } of ROUTES) {
		app.route(path, router);
	}

	// Everything that is not an API route is served from the built dashboard assets. A navigation
	// request that misses a real file falls back to index.html so client-side routes resolve (SPA).
	app.get('*', async (c) => {
		const { pathname } = new URL(c.req.url);
		if (pathname.startsWith('/api/')) {
			return c.json({ error: 'not_found' }, 404);
		}
		let res = await c.env.ASSETS.fetch(c.req.raw);
		if (res.status === 404 && (c.req.header('accept') ?? '').includes('text/html')) {
			const indexUrl = new URL('/index.html', c.req.url);
			res = await c.env.ASSETS.fetch(new Request(indexUrl, { method: 'GET' }));
		}
		return withDashboardSecurityHeaders(res);
	});

	app.notFound((c) => c.json({ error: 'not_found' }, 404));
	app.onError((err, c) => {
		if (err instanceof ApiError) {
			return c.json(toErrorBody(err), err.status);
		}
		// A 400 HTTPException here only comes from body parsing (malformed JSON / form).
		if (err instanceof HTTPException && err.status === 400) {
			return c.json({ error: 'validation_failed' }, 400);
		}
		// Never leak an unexpected error's message to the client; details go to logs only.
		return c.json({ error: 'internal_error' }, 500);
	});

	return app;
}
