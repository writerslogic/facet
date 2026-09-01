// Alert evaluation: the hourly pass that turns detected anomalies and matched user-defined metric
// thresholds into delivered alerts.
//
// It rides the EXISTING cron (registered from src/index.ts — no second schedule) and is registered
// as a normal ScheduledJob, so `runScheduled` already isolates it from the other jobs. Inside the
// job the same discipline applies one level down: a failure for one site, or one destination, or
// one delivery, is caught and recorded, never rethrown. The alerting path is not allowed to be the
// reason rollups or retention stop running.

import {
	ALERT_SEVERITIES,
	ANOMALY_ALERT_TYPE,
	type AlertPayload,
	type AlertSeverity,
	type AnomalyAlertPayload,
	METRIC_ALERT_METRICS,
	METRIC_ALERT_OPERATORS,
	METRIC_ALERT_TYPE,
	type MetricAlertMetric,
	type MetricAlertOperator,
	type MetricAlertPayload,
	meetsSeverity,
	severityForZ,
} from '@facet/shared';
import type { Anomaly, StatsSummary } from '@facet/shared';
import {
	type StoredDestination,
	type StoredMetricAlertRule,
	claimDelivery,
	enabledDestinations,
	enabledMetricAlertRules,
	markDelivered,
	markFailed,
} from '../db/alerts.js';
import { detectAnomalies } from '../db/anomaly.js';
import { summary } from '../db/stats.js';
import type { Env } from '../env.js';
import { DAY_MS, HOUR_MS } from './constants.js';
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

/** Stable identity of one rule breach. A rule may legitimately remain breached for several hours;
 * each completed hour is one observation and may alert once, while duplicate cron invocations for
 * that hour collide on this key. */
export function metricAlertDedupeKey(siteId: string, ruleId: string, windowStart: number): string {
	return `${siteId}:metric_rule:${ruleId}:${windowStart}`;
}

/** Claim and deliver one already-built alert fact to one destination. Transport and claim semantics
 * are shared by anomaly and metric alerts so retries, signing and SSRF checks cannot drift. */
async function deliverClaimedAlert(
	env: Env,
	dest: StoredDestination,
	input: {
		severity: AlertSeverity;
		dedupeKey: string;
		now: number;
		payload: (attempt: number) => AlertPayload;
	},
	fetchImpl?: FetchLike,
): Promise<void> {
	// Severity threshold: an operator asking for critical-only is asking not to be woken up.
	if (!meetsSeverity(input.severity, dest.min_severity as AlertSeverity)) {
		return;
	}
	// Claim BEFORE delivering. If this returns null the alert was already sent (or has exhausted
	// its attempts) and must not be sent again.
	const claim = await claimDelivery(env, {
		destinationId: dest.id,
		siteId: dest.site_id,
		dedupeKey: input.dedupeKey,
		severity: input.severity,
		now: input.now,
	});
	if (!claim) {
		return;
	}
	const outcome = await deliverAlert(env, dest, input.payload(claim.attempt), fetchImpl);
	if (outcome.ok) {
		await markDelivered(env, claim.id, input.now);
	} else {
		await markFailed(env, claim.id, input.now, outcome.error ?? 'unknown');
	}
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
	const dedupeKey = anomalyDedupeKey(dest.site_id, anomaly);
	await deliverClaimedAlert(
		env,
		dest,
		{
			severity,
			dedupeKey,
			now,
			payload: (attempt) =>
				buildPayload({ dest, anomaly, severity, dedupeKey, attempt, now }),
		},
		fetchImpl,
	);
}

/** Return a rule's counter from one exact summary, or null for a row written outside the validated
 * API with an unknown metric. Invalid stored configuration is skipped, never allowed to stop cron. */
function metricValue(rule: StoredMetricAlertRule, stats: StatsSummary): number | null {
	if (!METRIC_ALERT_METRICS.includes(rule.metric as MetricAlertMetric)) return null;
	return stats[rule.metric as MetricAlertMetric];
}

function metricRuleMatches(rule: StoredMetricAlertRule, value: number): boolean {
	if (!METRIC_ALERT_OPERATORS.includes(rule.operator as MetricAlertOperator)) return false;
	return rule.operator === 'at_least' ? value >= rule.threshold : value <= rule.threshold;
}

/** Deliver one matched metric rule to one destination. */
async function metricRuleDestination(
	env: Env,
	dest: StoredDestination,
	rule: StoredMetricAlertRule,
	value: number,
	windowStart: number,
	windowEnd: number,
	now: number,
	fetchImpl?: FetchLike,
): Promise<void> {
	if (!ALERT_SEVERITIES.includes(rule.severity as AlertSeverity)) return;
	if (!METRIC_ALERT_METRICS.includes(rule.metric as MetricAlertMetric)) return;
	if (!METRIC_ALERT_OPERATORS.includes(rule.operator as MetricAlertOperator)) return;
	const severity = rule.severity as AlertSeverity;
	const metric = rule.metric as MetricAlertMetric;
	const operator = rule.operator as MetricAlertOperator;
	const dedupeKey = metricAlertDedupeKey(rule.site_id, rule.id, windowStart);
	await deliverClaimedAlert(
		env,
		dest,
		{
			severity,
			dedupeKey,
			now,
			payload: (attempt): MetricAlertPayload => ({
				type: METRIC_ALERT_TYPE,
				delivery_id: crypto.randomUUID(),
				dedupe_key: dedupeKey,
				attempt,
				issued_at: now,
				destination_id: dest.id,
				site_id: rule.site_id,
				severity,
				rule: { id: rule.id, name: rule.name },
				observation: {
					metric,
					operator,
					threshold: rule.threshold,
					value,
					window_start: windowStart,
					window_end: windowEnd,
				},
			}),
		},
		fetchImpl,
	);
}

/**
 * Evaluate anomalies and metric rules for every site that has at least one enabled destination, then
 * deliver the ones that clear each destination's severity threshold. Sites with no destinations are
 * never queried, so a deployment that has not configured alerting costs one SELECT per hour.
 * OPTIMIZE: that SELECT scans — alert_destinations has no index leading with `enabled`.
 */
export async function runAlerts(env: Env, now: number, fetchImpl?: FetchLike): Promise<void> {
	const destinations = await enabledDestinations(env);
	if (destinations.length === 0) {
		return;
	}
	const log = createLogger({ job: 'alerts' });
	const rules = await enabledMetricAlertRules(env);
	const bySite = new Map<string, StoredDestination[]>();
	const rulesBySite = new Map<string, StoredMetricAlertRule[]>();
	for (const dest of destinations) {
		const list = bySite.get(dest.site_id);
		if (list) {
			list.push(dest);
		} else {
			bySite.set(dest.site_id, [dest]);
		}
	}
	for (const rule of rules) {
		const list = rulesBySite.get(rule.site_id);
		if (list) list.push(rule);
		else rulesBySite.set(rule.site_id, [rule]);
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

		const siteRules = rulesBySite.get(siteId);
		if (!siteRules || siteRules.length === 0) continue;
		// Always score the last COMPLETED UTC hour. A cron that fires at 12:03 still reads [11:00,
		// 12:00), so retries and delayed triggers observe the same immutable window.
		const windowEnd = now - (now % HOUR_MS);
		const windowStart = windowEnd - HOUR_MS;
		try {
			const stats = await summary(env, { siteId, start: windowStart, end: windowEnd });
			for (const rule of siteRules) {
				const value = metricValue(rule, stats);
				if (value === null || !metricRuleMatches(rule, value)) continue;
				for (const dest of sitedests) {
					try {
						await metricRuleDestination(
							env,
							dest,
							rule,
							value,
							windowStart,
							windowEnd,
							now,
							fetchImpl,
						);
					} catch (err) {
						log.error(
							`metric_alert_delivery_failed:${dest.id}:${rule.id}`,
							err instanceof Error ? err : String(err),
						);
					}
				}
			}
		} catch (err) {
			log.error(
				`metric_alert_eval_failed:${siteId}`,
				err instanceof Error ? err : String(err),
			);
		}
	}
}

/** The cron job. Registered onto the existing hourly trigger in src/index.ts. */
export const alertsJob: ScheduledJob = {
	name: 'alerts',
	cadence: '1h',
	run: (env, now) => runAlerts(env, now),
};
