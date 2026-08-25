// Alert evaluation: the hourly pass that turns detected anomalies into delivered alerts.
//
// It rides the EXISTING cron (registered from src/index.ts — no second schedule) and is registered
// as a normal ScheduledJob, so `runScheduled` already isolates it from the other jobs. Inside the
// job the same discipline applies one level down: a failure for one site, or one destination, or
// one delivery, is caught and recorded, never rethrown. The alerting path is not allowed to be the
// reason rollups or retention stop running.

import {
	ANOMALY_ALERT_TYPE,
	type AlertSeverity,
	type AnomalyAlertPayload,
	meetsSeverity,
	severityForZ,
} from '@facet/shared';
import type { Anomaly } from '@facet/shared';
import {
	type StoredDestination,
	claimDelivery,
	enabledDestinations,
	markDelivered,
	markFailed,
} from '../db/alerts.js';
import { detectAnomalies } from '../db/anomaly.js';
import type { Env } from '../env.js';
import { DAY_MS } from './constants.js';
import { createLogger } from './log.js';
import { type FetchLike, deliverAlert } from './notify.js';
import type { ScheduledJob } from './scheduled.js';

/** Stable identity of one anomaly, used as the dedupe key.
 *
 * The anomalous HOUR is part of the key, and that is the whole design. `detectAnomalies` scores the
 * last completed hour of a trailing 24h window, so the same (site, bucket, metric, direction) is
 * legitimately re-detected whenever the cron re-runs before that hour rolls over — a duplicate
 * cron trigger, a retry, or simply the next tick. All of those collide on this key and are dropped.
 * The next hour's anomaly is a genuinely different event and gets a different key. */
export function anomalyDedupeKey(siteId: string, a: Anomaly): string {
	return `${siteId}:${a.metric}:${a.bucket}:${a.direction}`;
}

/** Build the wire payload for one (destination, anomaly) delivery attempt. */
function buildPayload(input: {
	dest: StoredDestination;
	anomaly: Anomaly;
	severity: AlertSeverity;
	dedupeKey: string;
	attempt: number;
	now: number;
}): AnomalyAlertPayload {
	return {
		type: ANOMALY_ALERT_TYPE,
		delivery_id: crypto.randomUUID(),
		dedupe_key: input.dedupeKey,
		attempt: input.attempt,
		issued_at: input.now,
		destination_id: input.dest.id,
		site_id: input.dest.site_id,
		severity: input.severity,
		anomaly: input.anomaly,
	};
}

/** Deliver one anomaly to one destination, if it is not already claimed. Never throws. */
async function alertDestination(
	env: Env,
	dest: StoredDestination,
	anomaly: Anomaly,
	now: number,
	fetchImpl?: FetchLike,
): Promise<void> {
	const severity = severityForZ(anomaly.z);
	// Severity threshold: an operator asking for critical-only is asking not to be woken up.
	if (!meetsSeverity(severity, dest.min_severity as AlertSeverity)) {
		return;
	}
	const dedupeKey = anomalyDedupeKey(dest.site_id, anomaly);
	// Claim BEFORE delivering. If this returns null the alert was already sent (or has exhausted
	// its attempts) and must not be sent again.
	const claim = await claimDelivery(env, {
		destinationId: dest.id,
		siteId: dest.site_id,
		dedupeKey,
		severity,
		now,
	});
	if (!claim) {
		return;
	}
	const payload = buildPayload({
		dest,
		anomaly,
		severity,
		dedupeKey,
		attempt: claim.attempt,
		now,
	});
	const outcome = await deliverAlert(env, dest, payload, fetchImpl);
	if (outcome.ok) {
		await markDelivered(env, claim.id, now);
	} else {
		await markFailed(env, claim.id, now, outcome.error ?? 'unknown');
	}
}

/**
 * Evaluate anomalies for every site that has at least one enabled destination and deliver the ones
 * that clear each destination's threshold. Sites with no destinations are never queried, so a
 * deployment that has not configured alerting pays one indexed SELECT per hour and nothing else.
 */
export async function runAlerts(env: Env, now: number, fetchImpl?: FetchLike): Promise<void> {
	const destinations = await enabledDestinations(env);
	if (destinations.length === 0) {
		return;
	}
	const log = createLogger({ job: 'alerts' });
	const bySite = new Map<string, StoredDestination[]>();
	for (const dest of destinations) {
		const list = bySite.get(dest.site_id);
		if (list) {
			list.push(dest);
		} else {
			bySite.set(dest.site_id, [dest]);
		}
	}

	for (const [siteId, sitedests] of bySite) {
		try {
			const anomalies = await detectAnomalies(
				env,
				{ siteId, start: now - DAY_MS, end: now },
				now,
			);
			for (const anomaly of anomalies) {
				for (const dest of sitedests) {
					try {
						await alertDestination(env, dest, anomaly, now, fetchImpl);
					} catch (err) {
						// Only reachable if the claim/record writes themselves fail; the transports
						// already swallow their own errors.
						log.error(
							`alert_delivery_failed:${dest.id}`,
							err instanceof Error ? err : String(err),
						);
					}
				}
			}
		} catch (err) {
			log.error(`alert_eval_failed:${siteId}`, err instanceof Error ? err : String(err));
		}
	}
}

/** The cron job. Registered onto the existing hourly trigger in src/index.ts. */
export const alertsJob: ScheduledJob = {
	name: 'alerts',
	cadence: '1h',
	run: (env, now) => runAlerts(env, now),
};
