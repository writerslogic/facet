// API-key + admin auth: key resolves to its site and bumps last_used; bogus keys/tokens get a 401.

import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env.js';
import { issueKey } from '../src/lib/apikeys.js';
import { authenticateKey, requireAdmin, requireApiKey } from '../src/lib/auth.js';
import { ApiError, toErrorBody } from '../src/lib/http.js';

const SITE = '11111111-1111-4111-8111-111111111111';

function appWith(mw: MiddlewareHandler<AppEnv>) {
	const app = new Hono<AppEnv>();
	app.get('/p', mw, (c) => c.json({ ok: true, siteId: c.get('siteId') ?? null }));
	app.onError((err, c) =>
		err instanceof ApiError
			? c.json(toErrorBody(err), err.status)
			: c.json({ error: 'internal_error' }, 500),
	);
	return app;
}

describe('authenticateKey', () => {
	it('resolves a valid key to its site and bumps last_used', async () => {
		const { id, key } = await issueKey(env, SITE, null, Date.now());
		expect(await authenticateKey(env, `Bearer ${key}`)).toBe(SITE);
		const row = await env.DB.prepare('SELECT last_used FROM api_keys WHERE id = ?')
			.bind(id)
			.first<{ last_used: number | null }>();
		expect(row?.last_used).not.toBeNull();
	});

	it('returns null for a missing or bogus key', async () => {
		expect(await authenticateKey(env, null)).toBeNull();
		expect(await authenticateKey(env, 'Bearer clk_deadbeef')).toBeNull();
	});
});

describe('requireApiKey', () => {
	it('rejects a bogus key with 401 invalid_api_key', async () => {
		const res = await appWith(requireApiKey).request(
			'/p',
			{ headers: { Authorization: 'Bearer clk_nope' } },
			env,
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'invalid_api_key' });
	});

	it('passes a valid key and exposes its site_id', async () => {
		const { key } = await issueKey(env, SITE, null, Date.now());
		const res = await appWith(requireApiKey).request(
			'/p',
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, siteId: SITE });
	});
});

describe('requireAdmin', () => {
	it('accepts the configured admin token', async () => {
		const res = await appWith(requireAdmin).request(
			'/p',
			{ headers: { Authorization: 'Bearer test-admin-token' } },
			env,
		);
		expect(res.status).toBe(200);
	});

	it('rejects a wrong token and a missing header with 401 invalid_admin_token', async () => {
		const wrong = await appWith(requireAdmin).request(
			'/p',
			{ headers: { Authorization: 'Bearer wrong-token' } },
			env,
		);
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toEqual({ error: 'invalid_admin_token' });

		const missing = await appWith(requireAdmin).request('/p', {}, env);
		expect(missing.status).toBe(401);
	});

	it('fails closed when ADMIN_TOKEN is unset — no `Bearer undefined` bypass', async () => {
		// With an unset secret, sha256Hex(undefined) would coerce to sha256Hex("undefined"); a request
		// sending literally `Bearer undefined` must NOT authenticate.
		const noTokenEnv = {
			...env,
			ADMIN_TOKEN: undefined,
		} as unknown as typeof env;
		const res = await appWith(requireAdmin).request(
			'/p',
			{ headers: { Authorization: 'Bearer undefined' } },
			noTokenEnv,
		);
		expect(res.status).toBe(401);
	});
});
