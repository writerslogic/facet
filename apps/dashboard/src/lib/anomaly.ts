// Anomaly severity classification, plain-language framing of the detector's numbers, and the local
// dismissal store. Every value here is derived from the `Anomaly` fields the API already returns —
// nothing is invented client-side.

import type { Anomaly } from '@facet/shared';
import { formatHourWindow } from './datetime.js';

export type Severity = 'critical' | 'high' | 'moderate';

// Severity from |z|: >= 6 critical, >= 4.5 high, else moderate.
const CRITICAL_Z = 6;
const HIGH_Z = 4.5;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function severityFor(z: number): Severity {
	const mag = Math.abs(z);
	if (mag >= CRITICAL_Z) return 'critical';
	if (mag >= HIGH_Z) return 'high';
	return 'moderate';
}

/** Ordering weight so the most alarming anomaly is read first. */
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, moderate: 2 };

/**
 * Sort comparator: most severe first, then most recent bucket first. The detector currently returns
 * at most one anomaly per range, so this exists to keep the list deterministic (and correctly
 * ordered) if a range ever surfaces several, not to power a user-facing sort control.
 */
export function compareAnomalies(a: Anomaly, b: Anomaly): number {
	const bySeverity = SEVERITY_ORDER[severityFor(a.z)] - SEVERITY_ORDER[severityFor(b.z)];
	if (bySeverity !== 0) return bySeverity;
	return b.bucket - a.bucket;
}

/** Stable per-anomaly id: `${site}:${metric}:${bucket}`. A new bucket produces a new id. */
export function anomalyId(siteId: string, anomaly: Anomaly): string {
	return `${siteId}:${anomaly.metric}:${anomaly.bucket}`;
}

/** The ms bucket encoded in an anomaly id, or null when the id isn't in that shape. */
export function bucketFromId(id: string): number | null {
	const cut = id.lastIndexOf(':');
	if (cut < 0 || cut === id.length - 1) return null;
	const bucket = Number(id.slice(cut + 1));
	return Number.isFinite(bucket) ? bucket : null;
}

/**
 * Signed magnitude of the change vs baseline, or null when the baseline mean is zero — dividing by
 * it would render "Infinity%". The detector needs a non-zero stddev to fire, so a zero mean is
 * near-impossible in practice, but the UI must not print nonsense if it happens.
 */
export function changePct(a: Anomaly): number | null {
	if (!(a.baseline_mean > 0)) return null;
	return a.direction === 'drop'
		? Math.round((1 - a.value / a.baseline_mean) * 100)
		: Math.round((a.value / a.baseline_mean - 1) * 100);
}

/**
 * Plain-language framing of the z-score. z is the deviation measured in units of the baseline's own
 * standard deviation — i.e. of the hour-to-hour swing this site normally shows — so "3.4x the usual
 * hour-to-hour swing" is a literal restatement of the number, not a loose analogy.
 */
export function explainZ(z: number): string {
	return `${Math.abs(z).toFixed(1)}x the site's usual hour-to-hour swing`;
}

export interface BucketDescription {
	/** ISO instant for the bucket start, for a `<time datetime>` attribute. */
	iso: string;
	/** Absolute hour window in the active clock, always suffixed with it — "Jul 30, 14:00–15:00 UTC". */
	absolute: string;
	/** Coarse age of the end of that hour, e.g. "3h ago". */
	relative: string;
}

/**
 * Describe an anomaly's hour: buckets are hour-aligned starts, so the window ends an hour later.
 *
 * The label used to be hardcoded to `en-US` AND to UTC, sitting directly above experiment dates in
 * the browser's timezone. Both now come from `lib/datetime.ts`, so this hour reads in whichever clock
 * the reader picked and in their own locale — and never without naming the clock it is in.
 */
export function describeBucket(bucket: number, now: number): BucketDescription {
	const window = formatHourWindow(bucket, bucket + HOUR_MS);
	return {
		iso: window.iso,
		absolute: window.absolute,
		relative: relativeAge(now - (bucket + HOUR_MS)),
	};
}

function relativeAge(ms: number): string {
	if (ms < HOUR_MS) return 'within the last hour';
	if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h ago`;
	return `${Math.floor(ms / DAY_MS)}d ago`;
}

export interface AnomalySummary {
	total: number;
	critical: number;
	high: number;
	moderate: number;
	/** Most recent anomalous bucket, or null when there are none. */
	newest: number | null;
}

export function summarize(anomalies: readonly Anomaly[]): AnomalySummary {
	const summary: AnomalySummary = {
		total: anomalies.length,
		critical: 0,
		high: 0,
		moderate: 0,
		newest: null,
	};
	for (const a of anomalies) {
		summary[severityFor(a.z)] += 1;
		summary.newest = summary.newest === null ? a.bucket : Math.max(summary.newest, a.bucket);
	}
	return summary;
}

/**
 * One-line orientation above the list: how many, how bad, how recent, and how many of them the
 * reader has hidden — otherwise the count and the number of visible cards disagree with no
 * explanation.
 */
export function summaryLine(
	anomalies: readonly Anomaly[],
	now: number,
	dismissedCount = 0,
): string {
	const s = summarize(anomalies);
	if (s.total === 0) return 'No anomalies flagged in this range';
	const parts = [`${s.total} ${s.total === 1 ? 'anomaly' : 'anomalies'} in this range`];
	const bySeverity = [
		s.critical > 0 ? `${s.critical} critical` : null,
		s.high > 0 ? `${s.high} high` : null,
		s.moderate > 0 ? `${s.moderate} moderate` : null,
	].filter((x): x is string => x !== null);
	parts.push(bySeverity.join(', '));
	if (s.newest !== null) {
		parts.push(`latest ${describeBucket(s.newest, now).relative}`);
	}
	if (dismissedCount > 0) {
		parts.push(`${dismissedCount} dismissed`);
	}
	return parts.join(' · ');
}

const DISMISSED_STORAGE = 'facet.dismissedAnomalies';
/**
 * Hard bound on the stored list so a long-lived browser can't grow it forever. A time-based expiry
 * was rejected deliberately: custom ranges can reach arbitrarily far back, so ageing entries out
 * would silently resurrect anomalies the user had already dismissed. The cap alone bounds growth,
 * and evicting the oldest bucket first means only long-superseded hours are ever forgotten.
 */
export const DISMISS_MAX = 200;

function readRaw(): string[] {
	try {
		const raw = localStorage.getItem(DISMISSED_STORAGE);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((x): x is string => typeof x === 'string')
			: [];
	} catch {
		return [];
	}
}

function writeRaw(ids: readonly string[]): void {
	try {
		localStorage.setItem(DISMISSED_STORAGE, JSON.stringify(ids));
	} catch {
		// storage unavailable or full: dismissal is best-effort only.
	}
}

/**
 * Drop malformed and duplicate ids, then keep the newest `DISMISS_MAX` buckets. An id carrying no
 * parsable bucket can never equal a generated id, so it is pure dead weight.
 */
export function pruneDismissed(ids: readonly string[]): string[] {
	const byId = new Map<string, number>();
	for (const id of ids) {
		const bucket = bucketFromId(id);
		if (bucket === null) continue;
		byId.set(id, bucket);
	}
	return Array.from(byId)
		.sort(([, a], [, b]) => b - a)
		.slice(0, DISMISS_MAX)
		.map(([id]) => id);
}

/** Load the dismissal set, writing back a pruned list when anything was dropped. */
export function loadDismissed(): Set<string> {
	const raw = readRaw();
	const pruned = pruneDismissed(raw);
	if (pruned.length !== raw.length) {
		writeRaw(pruned);
	}
	return new Set(pruned);
}

export function dismissAnomaly(id: string): void {
	writeRaw(pruneDismissed([id, ...readRaw()]));
}

/** Undo a dismissal so the anomaly returns to the list. */
export function restoreAnomaly(id: string): void {
	writeRaw(readRaw().filter((x) => x !== id));
}
