// Alerting: the admin CRUD surface for alert destinations, the SSRF policy on operator-supplied
// webhook URLs, and the hourly cron pass that delivers anomalies exactly once.
//
// The properties worth pinning are the ones that make this safe to leave running unattended: alert
// config is admin-only, a URL we would not dial is refused at creation AND at delivery, an anomaly
// that was alerted on is never alerted on again, a severity threshold is honoured, and a dead
// endpoint degrades to a recorded failure instead of taking the cron down.

import { env } from 'cloudflare:workers';
import type { AnomalyAlertPayload, MetricAlertPayload } from '@facet/shared';
import { generateSigningJwk, verifyDetachedJws } from '@facet/trust';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { claimDelivery } from '../src/db/alerts.js';
import { insertEvent } from '../src/db/queries.js';
import { db } from '../src/db/queries.js';
import * as schema from '../src/db/schema.js';
import type { Env } from '../src/env.js';
import { alertsJob, runAlerts } from '../src/lib/alerts.js';
import { buildAlertMime, checkWebhookUrl } from '../src/lib/notify.js';
import { runScheduled } from '../src/lib/scheduled.js';

const app = createApp();
const ADMIN = 'Bearer test-admin-token';
const SITE = '77777777-7777-4777-8777-777777777777';
const HOOK = 'https://hooks.example.com/facet';
const HOUR = 3_600_000;
/** A whole number of hours since the epoch, so bucket alignment is exact. */
const NOW = Date.UTC(2026, 6, 2, 0, 0, 0, 0);

interface Call {
	url: string;
	init: RequestInit;
}

function recorder(behaviour: 'ok' | 'reject' | 'http500' = 'ok') {
	const calls: Call[] = [];
	const fetchImpl = vi.fn((url: string, init: RequestInit) => {
		calls.push({ url, init });
		if (behaviour === 'reject') {
			return Promise.reject(new Error('network'));
		}
		return Promise.resolve(
			behaviour === 'ok' ? { ok: true, status: 200 } : { ok: false, status: 500 },
		);
	});
	return { calls, fetchImpl: fetchImpl as never };
}

/** Create a site row plus 23 completed baseline hours of ~4 pageviews/h, then `last` pageviews in
 * the final completed hour. The baseline has nonzero variance, so a z-score exists. */
async function seedSite(last: number, siteId = SITE): Promise<void> {
	const base = NOW - 24 * HOUR;
	await db(env)
		.insert(schema.sites)
		.values({ id: siteId, name: 'S', domain: 's.example', createdAt: base })
		.onConflictDoNothing();
	const jitter = [4, 5, 3];
	const seedHour = async (bucket: number, count: number) => {
		for (let i = 0; i < count; i++) {
			await insertEvent(env, {
				siteId,
				hostname: 's.example',
				path: '/',
				referrer: '',
				name: null,
				props: null,
				visitorHash: `v-${bucket}-${i}`,
				country: 'US',
				device: 'desktop',
				createdAt: bucket + i * 60_000,
			});
		}
	};
	for (let h = 0; h < 23; h++) {
		await seedHour(base + h * HOUR, jitter[h % 3] ?? 4);
	}
	await seedHour(base + 23 * HOUR, last);
}

/** Seed only the last completed hour. With no 23-hour baseline this cannot produce an anomaly, so
 * metric-rule tests prove their own path rather than accidentally inspecting an anomaly payload. */
async function seedCompletedHourPageviews(count: number): Promise<void> {
	await db(env)
		.insert(schema.sites)
		.values({ id: SITE, name: 'S', domain: 's.example', createdAt: NOW - HOUR })
		.onConflictDoNothing();
	for (let i = 0; i < count; i++) {
		await insertEvent(env, {
			siteId: SITE,
			hostname: 's.example',
			path: '/',
			referrer: '',
			name: null,
			props: null,
			visitorHash: `metric-v-${i}`,
			country: 'US',
			device: 'desktop',
			createdAt: NOW - HOUR + i * 60_000,
		});
	}
}

async function createDestination(
	body: Record<string, unknown>,
	auth: string = ADMIN,
	path = '/api/alerts',
): Promise<Response> {
	return app.request(
		path,
		{
			method: 'POST',
			headers: { Authorization: auth, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		},
		env,
	);
}

/** Register a webhook destination and return its id + one-time secret. */
async function webhookDestination(
	overrides: Record<string, unknown> = {},
): Promise<{ id: string; secret: string }> {
	const res = await createDestination({
		site_id: SITE,
		name: 'ops',
		type: 'webhook',
		target: HOOK,
		...overrides,
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as {
		alert_destination: { id: string };
		secret: string;
	};
	return { id: body.alert_destination.id, secret: body.secret };
}

/** Register one metric rule through the admin API and return its public row. */
async function metricRule(
	overrides: Record<string, unknown> = {},
): Promise<{ id: string; name: string }> {
	const res = await createDestination(
		{
			site_id: SITE,
			name: 'Traffic floor',
			metric: 'pageviews',
			operator: 'at_least',
			threshold: 3,
			...overrides,
		},
		ADMIN,
		'/api/alerts/rules',
	);
	expect(res.status).toBe(201);
	const body = (await res.json()) as { metric_alert_rule: { id: string; name: string } };
	return body.metric_alert_rule;
}

async function deliveryRows(): Promise<
	{ status: string; attempts: number; last_error: string | null; dedupe_key: string }[]
> {
	const rows = await env.DB.prepare(
		'SELECT status, attempts, last_error, dedupe_key FROM alert_deliveries ORDER BY created_at',
	).all<{ status: string; attempts: number; last_error: string | null; dedupe_key: string }>();
	return rows.results;
}

describe('alert destinations: auth', () => {
	it('refuses every method without a bearer token', async () => {
		for (const res of [
			await app.request(`/api/alerts?site_id=${SITE}`, {}, env),
			await app.request(`/api/alerts/rules?site_id=${SITE}`, {}, env),
			await createDestination(
				{ site_id: SITE, name: 'x', type: 'webhook', target: HOOK },
				'',
			),
			await app.request(`/api/alerts/abc?site_id=${SITE}`, { method: 'DELETE' }, env),
		]) {
			expect(res.status).toBe(401);
		}
	});

	it('is NOT reachable with a site API key — alert config is admin-only', async () => {
		const siteRes = await app.request(
			'/api/sites',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'Acme', domain: 'acme.example' }),
			},
			env,
		);
		const { site } = (await siteRes.json()) as { site: { id: string } };
		const keyRes = await app.request(
			'/api/keys',
			{
				method: 'POST',
				headers: { Authorization: ADMIN, 'content-type': 'application/json' },
				body: JSON.stringify({ site_id: site.id }),
			},
			env,
		);
		const { key } = (await keyRes.json()) as { key: string };

		const create = await createDestination(
			{ site_id: site.id, name: 'x', type: 'webhook', target: HOOK },
			`Bearer ${key}`,
		);
		expect(create.status).toBe(401);
		expect(await create.json()).toEqual({ error: 'invalid_admin_token' });

		const list = await app.request(
			`/api/alerts?site_id=${site.id}`,
			{ headers: { Authorization: `Bearer ${key}` } },
			env,
		);
		expect(list.status).toBe(401);
	});
});

describe('alert destinations: CRUD', () => {
	it('round-trips create → list → delete, disclosing the secret exactly once', async () => {
		const created = await createDestination({
			site_id: SITE,
			name: 'ops webhook',
			type: 'webhook',
			target: HOOK,
			min_severity: 'critical',
		});
		expect(created.status).toBe(201);
		const body = (await created.json()) as {
			alert_destination: Record<string, unknown>;
			secret: string;
		};
		expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(body.alert_destination).toMatchObject({
			site_id: SITE,
			name: 'ops webhook',
			type: 'webhook',
			target: HOOK,
			min_severity: 'critical',
			enabled: true,
		});
		// The create response is the only place the secret ever appears.
		expect(body.alert_destination.secret).toBeUndefined();

		const list = await app.request(
			`/api/alerts?site_id=${SITE}`,
			{ headers: { Authorization: ADMIN } },
			env,
		);
		expect(list.status).toBe(200);
		const listed = (await list.json()) as {
			alert_destinations: Record<string, unknown>[];
		};
		expect(listed.alert_destinations).toHaveLength(1);
		expect(listed.alert_destinations[0]?.secret).toBeUndefined();
		expect(JSON.stringify(listed)).not.toContain(body.secret);

		const id = body.alert_destination.id as string;
		const del = await app.request(
			`/api/alerts/${id}?site_id=${SITE}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(del.status).toBe(200);
		expect(await del.json()).toEqual({ deleted: true });

		const after = await app.request(
			`/api/alerts?site_id=${SITE}`,
			{ headers: { Authorization: ADMIN } },
			env,
		);
		expect(
			((await after.json()) as { alert_destinations: unknown[] }).alert_destinations,
		).toHaveLength(0);
	});

	it('scopes list and delete to the site — another site cannot see or remove it', async () => {
		const { id } = await webhookDestination();
		const other = '88888888-8888-4888-8888-888888888888';
		const list = await app.request(
			`/api/alerts?site_id=${other}`,
			{ headers: { Authorization: ADMIN } },
			env,
		);
		expect(
			((await list.json()) as { alert_destinations: unknown[] }).alert_destinations,
		).toHaveLength(0);
		const del = await app.request(
			`/api/alerts/${id}?site_id=${other}`,
			{ method: 'DELETE', headers: { Authorization: ADMIN } },
			env,
		);
		expect(del.status).toBe(404);
	});

	it('rejects a malformed body with the canonical validation envelope', async () => {
		const res = await createDestination({
			site_id: 'not-a-uuid',
			name: '',
			type: 'carrier-pigeon',
			target: HOOK,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; issues: unknown[] };
		expect(body.error).toBe('validation_failed');
		expect(body.issues.length).toBeGreaterThan(0);
	});

	it('rejects an email destination whose target is not an address', async () => {
		const res = await createDestination({
			site_id: SITE,
			name: 'oncall',
			type: 'email',
			target: 'not-an-address',
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_email_target' });
	});

	it('accepts an email destination and mints no secret for it', async () => {
		const res = await createDestination({
			site_id: SITE,
			name: 'oncall',
			type: 'email',
			target: 'oncall@example.com',
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { secret?: string };
		expect(body.secret).toBeUndefined();
	});
});

describe('metric alert rules: CRUD', () => {
	it('round-trips an immutable hourly rule and scopes deletion to its site', async () => {
		const rule = await metricRule({
			name: 'No traffic',
			operator: 'at_most',
			threshold: 0,
			severity: 'critical',
		});

		const list = await app.request(
			`/api/alerts/rules?site_id=${SITE}`,
			{
				headers: { Authorization: ADMIN },
			},
			env,
		);
		expect(list.status).toBe(200);
		const body = (await list.json()) as { metric_alert_rules: Record<string, unknown>[] };
		expect(body.metric_alert_rules).toHaveLength(1);
		expect(body.metric_alert_rules[0]).toMatchObject({
			id: rule.id,
			name: 'No traffic',
			metric: 'pageviews',
			operator: 'at_most',
			threshold: 0,
			severity: 'critical',
			enabled: true,
			window_minutes: 60,
		});

		const otherSite = '88888888-8888-4888-8888-888888888888';
		const refused = await app.request(
			`/api/alerts/rules/${rule.id}?site_id=${otherSite}`,
			{
				method: 'DELETE',
				headers: { Authorization: ADMIN },
			},
			env,
		);
		expect(refused.status).toBe(404);

		const deleted = await app.request(
			`/api/alerts/rules/${rule.id}?site_id=${SITE}`,
			{
				method: 'DELETE',
				headers: { Authorization: ADMIN },
			},
			env,
		);
		expect(deleted.status).toBe(200);
	});

	it('rejects fractional, negative and unknown threshold conditions', async () => {
		for (const patch of [
			{ threshold: -1 },
			{ threshold: 1.5 },
			{ metric: 'revenue' },
			{ operator: 'approximately' },
		]) {
			const res = await createDestination(
				{
					site_id: SITE,
					name: 'bad',
					metric: 'pageviews',
					operator: 'at_least',
					threshold: 1,
					...patch,
				},
				ADMIN,
				'/api/alerts/rules',
			);
			expect(res.status).toBe(400);
		}
	});
});

describe('SSRF policy', () => {
	const blocked: [string, string][] = [
		['http://hooks.example.com/x', 'scheme_not_https'],
		['ftp://hooks.example.com/x', 'scheme_not_https'],
		['https://user:pw@hooks.example.com/x', 'credentials_in_url'],
		['https://hooks.example.com:8080/x', 'blocked_port'],
		['https://127.0.0.1/x', 'private_address'],
		// Obfuscated loopback: the URL parser normalizes all of these to 127.0.0.1.
		['https://0177.0.0.1/x', 'private_address'],
		['https://2130706433/x', 'private_address'],
		['https://0x7f000001/x', 'private_address'],
		['https://10.0.0.5/x', 'private_address'],
		['https://172.16.9.9/x', 'private_address'],
		['https://192.168.1.1/x', 'private_address'],
		['https://169.254.169.254/latest/meta-data/', 'private_address'],
		['https://100.64.0.1/x', 'private_address'],
		['https://0.0.0.0/x', 'private_address'],
		['https://255.255.255.255/x', 'private_address'],
		['https://[::1]/x', 'private_address'],
		['https://[::ffff:127.0.0.1]/x', 'private_address'],
		['https://[fd00::1]/x', 'private_address'],
		['https://[fe80::1]/x', 'private_address'],
		// 6to4/Teredo embed an arbitrary client IPv4 in the address; these wrap the cloud-metadata
		// address and the loopback address respectively, so both must still be refused.
		['https://[2002:a9fe:a9fe::]/x', 'private_address'],
		['https://[2001::80ff:fffe]/x', 'private_address'],
		['https://localhost/x', 'blocked_host'],
		['https://metadata.google.internal/x', 'blocked_host'],
		['https://foo.internal/x', 'blocked_host'],
		['https://build.local/x', 'blocked_host'],
		['https://gitlab/x', 'single_label_host'],
		['not a url at all', 'malformed_url'],
	];

	it.each(blocked)('refuses %s', (url, reason) => {
		expect(checkWebhookUrl(url)).toBe(reason);
	});

	it('allows an ordinary public https endpoint', () => {
		expect(checkWebhookUrl(HOOK)).toBeNull();
		expect(checkWebhookUrl('https://hooks.example.com:443/x')).toBeNull();
		expect(checkWebhookUrl('https://8.8.8.8/x')).toBeNull();
	});

	it('allows 6to4/Teredo wrapping a public IPv4 (proves the unwrap checks the embedded address, not just the prefix)', () => {
		expect(checkWebhookUrl('https://[2002:808:808::]/x')).toBeNull();
		expect(checkWebhookUrl('https://[2001::f7f7:f7f7]/x')).toBeNull();
	});

	it('refuses to store a blocked URL, without echoing the URL back', async () => {
		const res = await createDestination({
			site_id: SITE,
			name: 'ssrf',
			type: 'webhook',
			target: 'https://169.254.169.254/latest/meta-data/',
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; message?: string };
		expect(body.error).toBe('invalid_webhook_url');
		expect(body.message).toBe('private_address');
		expect(JSON.stringify(body)).not.toContain('169.254.169.254');
		expect(await deliveryRows()).toHaveLength(0);
	});

	it('re-checks at delivery time, so a row that predates the policy is never dialled', async () => {
		// Insert straight into D1, bypassing the route — this is the "stored before the policy
		// tightened" case, and the delivery path must catch it.
		await db(env).insert(schema.alertDestinations).values({
			id: 'legacy-1',
			site_id: SITE,
			name: 'legacy',
			type: 'webhook',
			target: 'http://169.254.169.254/latest/meta-data/',
			min_severity: 'warning',
			secret: 'abc',
			enabled: 1,
			created_at: NOW,
		});
		await seedSite(1);
		const { calls, fetchImpl } = recorder();
		await runAlerts(env as Env, NOW, fetchImpl);
		expect(calls).toHaveLength(0);
		const rows = await deliveryRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: 'failed', last_error: 'scheme_not_https' });
	});
});

describe('cron alerting', () => {
	it('skips a disabled destination entirely', async () => {
		await webhookDestination({ enabled: false });
		await seedSite(1);
		const { calls, fetchImpl } = recorder();
		await runAlerts(env as Env, NOW, fetchImpl);
		expect(calls).toHaveLength(0);
		// Not even claimed: a disabled destination leaves no delivery row to resume from.
		expect(await deliveryRows()).toHaveLength(0);
	});

	it('does nothing at all when no destination is configured', async () => {
		await seedSite(1);
		const { calls, fetchImpl } = recorder();
		await runAlerts(env as Env, NOW, fetchImpl);
		expect(calls).toHaveLength(0);
		expect(await deliveryRows()).toHaveLength(0);
	});

	it('delivers a matched metric rule once for the last completed UTC hour', async () => {
		const { id: destinationId } = await webhookDestination();
		const rule = await metricRule({ threshold: 3, severity: 'critical' });
		await seedCompletedHourPageviews(3);
		const first = recorder();
		await runAlerts(env as Env, NOW + 3 * 60_000, first.fetchImpl);

		expect(first.calls).toHaveLength(1);
		const payload = JSON.parse(String(first.calls[0]?.init.body)) as MetricAlertPayload;
		expect(payload).toMatchObject({
			type: 'facet.metric.alert/1',
			destination_id: destinationId,
			site_id: SITE,
			severity: 'critical',
			rule: { id: rule.id, name: 'Traffic floor' },
			observation: {
				metric: 'pageviews',
				operator: 'at_least',
				threshold: 3,
				value: 3,
				window_start: NOW - HOUR,
				window_end: NOW,
			},
		});
		expect(payload.dedupe_key).toBe(`${SITE}:metric_rule:${rule.id}:${NOW - HOUR}`);

		// Same completed hour, delayed duplicate trigger: one observation, one delivery.
		const duplicate = recorder();
		await runAlerts(env as Env, NOW + 10 * 60_000, duplicate.fetchImpl);
		expect(duplicate.calls).toHaveLength(0);
		expect(await deliveryRows()).toHaveLength(1);
	});

	it('does not claim or deliver an unmatched metric rule', async () => {
		await webhookDestination();
		await metricRule({ threshold: 4 });
		await seedCompletedHourPageviews(3);
		const { calls, fetchImpl } = recorder();
		await runAlerts(env as Env, NOW, fetchImpl);
		expect(calls).toHaveLength(0);
		expect(await deliveryRows()).toHaveLength(0);
	});

	it('delivers a signed, replay-bounded payload for a real anomaly', async () => {
		const { id, secret } = await webhookDestination();
		await seedSite(1); // sharp drop from a ~4/h baseline
		const { calls, fetchImpl } = recorder();
		await runAlerts(env as Env, NOW, fetchImpl);

		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.url).toBe(HOOK);
		// A public host must not be able to redirect us into the space the SSRF check just excluded.
		expect(call?.init.redirect).toBe('manual');

		const headers = call?.init.headers as Record<string, string>;
		const body = String(call?.init.body);
		const payload = JSON.parse(body) as {
			type: string;
			delivery_id: string;
			dedupe_key: string;
			attempt: number;
			issued_at: number;
			destination_id: string;
			severity: string;
			anomaly: { direction: string; bucket: number };
		};
		expect(payload.type).toBe('facet.anomaly.alert/1');
		expect(payload.destination_id).toBe(id);
		expect(payload.attempt).toBe(1);
		expect(payload.issued_at).toBe(NOW);
		expect(payload.severity).toBe('warning');
		expect(payload.anomaly.direction).toBe('drop');
		expect(payload.dedupe_key).toBe(`${SITE}:pageviews:${payload.anomaly.bucket}:drop`);

		// The timestamp is bound INTO the MAC, so a captured delivery cannot be replayed re-dated.
		expect(headers['facet-alert-timestamp']).toBe(String(NOW));
		expect(headers['facet-alert-id']).toBe(payload.delivery_id);
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const mac = new Uint8Array(
			await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${NOW}.${body}`)),
		);
		const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
		expect(headers['facet-alert-signature']).toBe(`v1=${hex}`);

		const rows = await deliveryRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: 'delivered', attempts: 1 });

		// No deployment signing key configured, so only the shared-secret MAC is offered.
		expect(headers['facet-signature-jws']).toBeUndefined();
	});

	it('adds a publicly verifiable detached JWS when a deployment key is configured', async () => {
		await webhookDestination();
		await seedSite(1);
		const { privateJwk, publicJwk } = await generateSigningJwk();
		const signing = { ...env, FACET_SIGNING_JWK: JSON.stringify(privateJwk) } as unknown as Env;

		const { calls, fetchImpl } = recorder();
		await runAlerts(signing, NOW, fetchImpl);

		const headers = calls[0]?.init.headers as Record<string, string>;
		const body = String(calls[0]?.init.body);
		expect(headers['facet-signing-key-id']).toBe(publicJwk.kid);
		// The body is RFC 8785 canonical JSON, so a receiver reproduces the signed bytes verbatim —
		// this is the same detached-JWS primitive the signed-export path uses.
		await expect(
			verifyDetachedJws(
				headers['facet-signature-jws'] ?? '',
				new TextEncoder().encode(body),
				publicJwk,
			),
		).resolves.toBeDefined();
		// Canonical JSON: object keys are sorted, so the signed bytes are order-independent.
		expect(body.startsWith('{"anomaly":')).toBe(true);

		// Tampering with the payload breaks the signature.
		await expect(
			verifyDetachedJws(
				headers['facet-signature-jws'] ?? '',
				new TextEncoder().encode(body.replace('"attempt":1', '"attempt":2')),
				publicJwk,
			),
		).rejects.toThrow();
	});

	it('never re-alerts the same anomaly across two cron runs', async () => {
		await webhookDestination();
		await seedSite(1);

		const first = recorder();
		await runAlerts(env as Env, NOW, first.fetchImpl);
		expect(first.calls).toHaveLength(1);

		// Same hour, second trigger (a duplicate cron, or a retry). The anomaly is legitimately
		// re-detected; it must not be re-delivered.
		const second = recorder();
		await runAlerts(env as Env, NOW, second.fetchImpl);
		expect(second.calls).toHaveLength(0);

		// And an hour later, when detection re-scores the very same bucket as the last completed
		// hour boundary has not moved past it, still nothing.
		const third = recorder();
		await runAlerts(env as Env, NOW + 60_000, third.fetchImpl);
		expect(third.calls).toHaveLength(0);

		const rows = await deliveryRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe('delivered');
	});

	it('honours the per-destination severity threshold', async () => {
		await createDestination({
			site_id: SITE,
			name: 'pager',
			type: 'webhook',
			target: 'https://pager.example.com/hook',
			min_severity: 'critical',
		});
		await createDestination({
			site_id: SITE,
			name: 'chat',
			type: 'webhook',
			target: 'https://chat.example.com/hook',
			min_severity: 'warning',
		});
		await seedSite(1); // |z| ≈ 3.7 — a warning, not a critical

		const { calls, fetchImpl } = recorder();
		await runAlerts(env as Env, NOW, fetchImpl);
		expect(calls.map((c) => c.url)).toEqual(['https://chat.example.com/hook']);
	});

	it('delivers to a critical-only destination when the anomaly is large enough', async () => {
		await createDestination({
			site_id: SITE,
			name: 'pager',
			type: 'webhook',
			target: 'https://pager.example.com/hook',
			min_severity: 'critical',
		});
		await seedSite(10); // a spike far past the critical z threshold

		const { calls, fetchImpl } = recorder();
		await runAlerts(env as Env, NOW, fetchImpl);
		expect(calls).toHaveLength(1);
		const payload = JSON.parse(String(calls[0]?.init.body)) as {
			severity: string;
			anomaly: { direction: string };
		};
		expect(payload.severity).toBe('critical');
		expect(payload.anomaly.direction).toBe('spike');
	});

	it('records a failed delivery, retries it, and gives up after a bounded number of attempts', async () => {
		await webhookDestination();
		await seedSite(1);

		for (let run = 1; run <= 3; run++) {
			const { calls, fetchImpl } = recorder('reject');
			await expect(runAlerts(env as Env, NOW, fetchImpl)).resolves.toBeUndefined();
			expect(calls).toHaveLength(1);
			const rows = await deliveryRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ status: 'failed', attempts: run });
			expect(rows[0]?.last_error).toContain('fetch_failed');
		}

		// Attempts exhausted: a permanently broken endpoint stops costing work every hour.
		const fourth = recorder('reject');
		await runAlerts(env as Env, NOW, fourth.fetchImpl);
		expect(fourth.calls).toHaveLength(0);
		expect((await deliveryRows())[0]?.attempts).toBe(3);
	});

	it('treats a non-2xx response as a failure rather than a delivery', async () => {
		await webhookDestination();
		await seedSite(1);
		const { fetchImpl } = recorder('http500');
		await runAlerts(env as Env, NOW, fetchImpl);
		const rows = await deliveryRows();
		expect(rows[0]).toMatchObject({ status: 'failed', last_error: 'http_500' });
	});

	it('records email as unconfigured rather than half-working, with no binding present', async () => {
		await createDestination({
			site_id: SITE,
			name: 'oncall',
			type: 'email',
			target: 'oncall@example.com',
		});
		await seedSite(1);
		await expect(runAlerts(env as Env, NOW)).resolves.toBeUndefined();
		const rows = await deliveryRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: 'failed', last_error: 'email_unconfigured' });
	});

	it('delivers through the optional send_email binding when it IS present', async () => {
		await createDestination({
			site_id: SITE,
			name: 'oncall',
			type: 'email',
			target: 'oncall@example.com',
		});
		await seedSite(1);
		const sent: { from: string; to: string }[] = [];
		const withEmail = {
			...env,
			ALERT_EMAIL_FROM: 'alerts@zone.example',
			SEND_EMAIL: {
				send: async (m: { from: string; to: string }) => {
					sent.push(m);
				},
			},
		} as unknown as Env;

		await runAlerts(withEmail, NOW);

		// A real workerd EmailMessage was constructed from the built MIME and handed to the binding.
		expect(sent).toHaveLength(1);
		expect(sent[0]?.from).toBe('alerts@zone.example');
		expect(sent[0]?.to).toBe('oncall@example.com');
		expect((await deliveryRows())[0]?.status).toBe('delivered');
	});

	it('does not break the cron: a failing delivery still lets later jobs run', async () => {
		await webhookDestination();
		await seedSite(1);
		let ran = false;
		const event = {
			scheduledTime: NOW,
			cron: '0 * * * *',
			noRetry() {},
		} as unknown as ScheduledController;

		// `alertsJob` calls `runAlerts` with no injectable fetch, so the unreachable-endpoint case has
		// to be produced at the global. It used to be produced by letting the real `fetch` try to dial
		// hooks.example.com and fail, which made the assertion depend on the runner's DNS: a resolver
		// that answers NXDOMAIN with a landing page (common on ISP and VPN networks) fails it outright,
		// and workerd surfaced the abandoned connection as an unhandled `internal error` rejection on
		// every run of this suite.
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.reject(new Error('unreachable'))),
		);
		try {
			await expect(
				runScheduled(event, env as Env, [
					alertsJob,
					{
						name: 'after',
						cadence: '1h',
						run: async () => {
							ran = true;
						},
					},
				]),
			).resolves.toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
		expect(ran).toBe(true);
		// A dead endpoint must be recorded, not thrown.
		const rows = await deliveryRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe('failed');
	});
});

describe('claimDelivery: overlapping cron invocations', () => {
	it('refuses a second claim on a fresh pending delivery — no double-send window', async () => {
		const first = await claimDelivery(env as Env, {
			destinationId: 'dest-race',
			siteId: SITE,
			dedupeKey: 'race-1',
			severity: 'warning',
			now: NOW,
		});
		expect(first).not.toBeNull();

		// A duplicate Cron Trigger fire racing in while `first` is presumably still mid-delivery.
		const second = await claimDelivery(env as Env, {
			destinationId: 'dest-race',
			siteId: SITE,
			dedupeKey: 'race-1',
			severity: 'warning',
			now: NOW + 1_000,
		});
		expect(second).toBeNull();
	});

	it('lets a later run reclaim a pending delivery once it is stale enough to presume the holder dead', async () => {
		const first = await claimDelivery(env as Env, {
			destinationId: 'dest-stale',
			siteId: SITE,
			dedupeKey: 'race-2',
			severity: 'warning',
			now: NOW,
		});
		expect(first).not.toBeNull();

		// Simulates an isolate that died mid-POST: no markDelivered/markFailed ever ran, so status
		// stays 'pending' forever unless a later run is allowed to retry it.
		const second = await claimDelivery(env as Env, {
			destinationId: 'dest-stale',
			siteId: SITE,
			dedupeKey: 'race-2',
			severity: 'warning',
			now: NOW + 60_000,
		});
		expect(second).not.toBeNull();
		expect(second?.attempt).toBe(2);
	});
});

describe('alert email MIME', () => {
	const payload: AnomalyAlertPayload = {
		type: 'facet.anomaly.alert/1',
		delivery_id: 'd-1',
		dedupe_key: `${SITE}:pageviews:${NOW - HOUR}:drop`,
		attempt: 1,
		issued_at: NOW,
		destination_id: 'dest-1',
		site_id: SITE,
		severity: 'warning',
		anomaly: {
			metric: 'pageviews',
			bucket: NOW - HOUR,
			value: 1,
			baseline_mean: 4,
			z: -3.7,
			direction: 'drop',
			diagnosis: null,
			summary: 'Pageviews dropped 75% in the last hour (z=-3.7).',
		},
	};

	it('builds a single-part base64 message whose body decodes to the summary', () => {
		const raw = buildAlertMime(payload, 'alerts@zone.example', 'oncall@example.com');
		expect(raw).toContain('From: Facet Alerts <alerts@zone.example>');
		expect(raw).toContain('To: oncall@example.com');
		expect(raw).toMatch(/^Subject: \[facet\] warning: Pageviews dropped/m);
		expect(raw).toContain('Message-ID: <d-1@zone.example>');
		expect(raw).toContain('Content-Transfer-Encoding: base64');
		const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
		const decoded = atob(body.replace(/\r\n/g, ''));
		expect(decoded).toContain('Pageviews dropped 75%');
		expect(decoded).toContain('severity:      warning');
	});

	it('strips CR/LF from event-derived text, so a summary cannot inject a header', () => {
		// The summary embeds a dimension value straight out of the events table.
		const hostile: AnomalyAlertPayload = {
			...payload,
			anomaly: {
				...payload.anomaly,
				summary: 'Pageviews dropped.\r\nBcc: attacker@evil.example\r\n',
			},
		};
		const raw = buildAlertMime(hostile, 'alerts@zone.example', 'oncall@example.com');
		const headerLines = (raw.split('\r\n\r\n')[0] ?? '').split('\r\n');
		// The injected text survives as literal Subject content, but it is no longer a header: the
		// CRLF that would have started one is gone.
		expect(headerLines.some((l) => l.startsWith('Bcc:'))).toBe(false);
		expect(headerLines.filter((l) => l.startsWith('Subject:'))).toHaveLength(1);
		expect(headerLines).toHaveLength(8);
	});

	it('renders a metric rule as its own readable subject and windowed body', () => {
		const metric: MetricAlertPayload = {
			type: 'facet.metric.alert/1',
			delivery_id: 'd-2',
			dedupe_key: `${SITE}:metric_rule:r-1:${NOW - HOUR}`,
			attempt: 1,
			issued_at: NOW,
			destination_id: 'dest-1',
			site_id: SITE,
			severity: 'critical',
			rule: { id: 'r-1', name: 'Traffic disappeared' },
			observation: {
				metric: 'pageviews',
				operator: 'at_most',
				threshold: 0,
				value: 0,
				window_start: NOW - HOUR,
				window_end: NOW,
			},
		};
		const raw = buildAlertMime(metric, 'alerts@zone.example', 'oncall@example.com');
		expect(raw).toMatch(
			/^Subject: \[facet\] critical: Traffic disappeared: pageviews was 0 \(threshold at most 0\)/m,
		);
		const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
		const decoded = atob(body.replace(/\r\n/g, ''));
		expect(decoded).toContain('operator:      at_most');
		expect(decoded).toContain(`window start:  ${new Date(NOW - HOUR).toISOString()}`);
	});
});
