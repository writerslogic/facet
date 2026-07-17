// E.20: optional anomaly-alert webhook. Disabled unless WEBHOOK_URL is configured. Deliveries are
// HMAC-SHA256 signed (when WEBHOOK_SECRET is set), time-bounded, and best-effort — a failed webhook
// never throws into the scheduled handler and is never a dependency of analytics ingestion. The
// hourly cron evaluates only the last completed hour, so each anomalous (site, bucket) is delivered
// at most once; consumers should still dedupe on the payload's `site_id`+`bucket`.

import type { Anomaly } from '@facet/shared';
import { detectAnomalies } from '../db/anomaly.js';
import { db } from '../db/queries.js';
import * as schema from '../db/schema.js';
import type { Env } from '../env.js';
import { DAY_MS } from './constants.js';
import { toHex } from './crypto.js';
import { createLogger } from './log.js';

/** Delivery timeout in ms (bounded so a slow endpoint can't stall the cron). */
const WEBHOOK_TIMEOUT_MS = 5000;

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

/** HMAC-SHA256 of `message` under `secret`, lowercase hex. */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
	return toHex(new Uint8Array(sig));
}

export interface AnomalyWebhookPayload {
	type: 'anomaly';
	site_id: string;
	metric: Anomaly['metric'];
	bucket: number;
	direction: Anomaly['direction'];
	z: number;
	value: number;
	baseline_mean: number;
	summary: string;
	delivered_at: number;
}

/** POST one signed anomaly payload. Best-effort: bounded, catches all errors, never throws. */
export async function deliverAnomalyWebhook(
	env: Env,
	payload: AnomalyWebhookPayload,
	fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<boolean> {
	if (!env.WEBHOOK_URL) {
		return false;
	}
	const body = JSON.stringify(payload);
	const headers: Record<string, string> = {
		'content-type': 'application/json',
	};
	if (env.WEBHOOK_SECRET) {
		headers['X-Facet-Signature'] = `sha256=${await hmacSha256Hex(env.WEBHOOK_SECRET, body)}`;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
	try {
		const res = await fetchImpl(env.WEBHOOK_URL, {
			method: 'POST',
			headers,
			body,
			signal: controller.signal,
		});
		return res.ok;
	} catch {
		// Swallow: webhook delivery is never a dependency of ingestion or of other cron jobs.
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** Scheduled job: detect the last completed hour's anomaly per site and deliver a webhook for each. */
export async function notifyAnomalies(
	env: Env,
	now: number,
	fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
	if (!env.WEBHOOK_URL) {
		return;
	}
	const log = createLogger({ job: 'anomaly-alerts' });
	const sites = await db(env).select({ id: schema.sites.id }).from(schema.sites);
	for (const { id } of sites) {
		try {
			const anomalies = await detectAnomalies(
				env,
				{ siteId: id, start: now - DAY_MS, end: now },
				now,
			);
			for (const a of anomalies) {
				await deliverAnomalyWebhook(
					env,
					{
						type: 'anomaly',
						site_id: id,
						metric: a.metric,
						bucket: a.bucket,
						direction: a.direction,
						z: a.z,
						value: a.value,
						baseline_mean: a.baseline_mean,
						summary: a.summary,
						delivered_at: now,
					},
					fetchImpl,
				);
			}
		} catch (err) {
			log.error(`anomaly_alert_failed:${id}`, err instanceof Error ? err : String(err));
		}
	}
}
