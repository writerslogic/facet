// Alerting: where a deployment is told that something broke. An anomaly is only useful if it
// reaches an operator, so a site can register alert *destinations* (admin-only) and the hourly cron
// delivers a signed payload to each one whose severity threshold the anomaly clears.
//
// This module is the wire contract shared by the server and any future dashboard/CLI: the valibot
// schema the admin API validates against, the severity ladder, and the exact payload a webhook
// receiver will see. It deliberately has no runtime dependency beyond valibot.

import * as v from 'valibot';
import type { Anomaly } from './stats.js';

/** Severity ladder, ascending. `info` exists as a "send me everything" threshold. */
export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Ordering for threshold comparisons — the single place severity is ranked. */
const SEVERITY_RANK: Record<AlertSeverity, number> = {
	info: 0,
	warning: 1,
	critical: 2,
};

/**
 * |z| at/above which an anomaly is `critical`. Detection already has a floor of ANOMALY_Z (3.0), so
 * every anomaly that exists is at least `warning`; this second, higher bar is what lets an operator
 * ask for critical-only without also having to re-tune detection.
 */
export const ALERT_CRITICAL_Z = 5.0;

/** Severity of an anomaly, from the magnitude of its signed z-score. */
export function severityForZ(z: number): AlertSeverity {
	return Math.abs(z) >= ALERT_CRITICAL_Z ? 'critical' : 'warning';
}

/** True when `severity` is at or above a destination's `min_severity` threshold. */
export function meetsSeverity(severity: AlertSeverity, min: AlertSeverity): boolean {
	return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

/** Transports an alert can be delivered over. */
export const ALERT_DESTINATION_TYPES = ['webhook', 'email'] as const;
export type AlertDestinationType = (typeof ALERT_DESTINATION_TYPES)[number];

/**
 * Create body for `POST /api/alerts` (admin-only). `target` is a transport-specific address — an
 * https URL for `webhook`, a mailbox for `email` — and is validated *again* server-side against the
 * SSRF policy, because a URL that merely parses is not a URL we are willing to POST to.
 */
export const AlertDestinationSchema = v.object({
	site_id: v.pipe(v.string(), v.uuid()),
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	type: v.picklist(ALERT_DESTINATION_TYPES),
	target: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
	min_severity: v.optional(v.picklist(ALERT_SEVERITIES)),
	enabled: v.optional(v.boolean()),
});

export type AlertDestinationInput = v.InferOutput<typeof AlertDestinationSchema>;

/** A stored alert destination as returned by the admin API. The webhook signing secret is NEVER
 * part of this view; it is returned exactly once, in the create response. */
export interface AlertDestination {
	id: string;
	site_id: string;
	name: string;
	type: AlertDestinationType;
	target: string;
	min_severity: AlertSeverity;
	enabled: boolean;
	created_at: number;
}

/** Payload envelope identifier, versioned so a receiver can detect a format change. */
export const ANOMALY_ALERT_TYPE = 'facet.anomaly.alert/1' as const;

/**
 * The exact JSON body POSTed to a webhook (serialized RFC 8785-canonically so the signature covers
 * bytes the receiver can reproduce). Replay handling is the receiver's, and we give it everything it
 * needs: `issued_at` bounds freshness, `delivery_id` is unique per attempt, and `dedupe_key` is
 * stable per underlying anomaly so a retry of a delivery we could not confirm is recognisable as the
 * same alert rather than a new one.
 */
export interface AnomalyAlertPayload {
	type: typeof ANOMALY_ALERT_TYPE;
	/** Unique per delivery attempt. */
	delivery_id: string;
	/** Stable per underlying anomaly: repeats only when we are retrying the same alert. */
	dedupe_key: string;
	/** 1-based attempt counter for this alert. */
	attempt: number;
	/** Delivery time, ms since epoch. Also bound into the HMAC, so it cannot be re-dated. */
	issued_at: number;
	destination_id: string;
	site_id: string;
	severity: AlertSeverity;
	anomaly: Anomaly;
}
