// Anomaly severity classification + local dismissal state.

import type { Anomaly } from '@facet/shared';

export type Severity = 'critical' | 'high' | 'moderate';

// Severity from |z|: >= 6 critical, >= 4.5 high, else moderate.
const CRITICAL_Z = 6;
const HIGH_Z = 4.5;

export function severityFor(z: number): Severity {
	const mag = Math.abs(z);
	if (mag >= CRITICAL_Z) return 'critical';
	if (mag >= HIGH_Z) return 'high';
	return 'moderate';
}

/** Stable per-anomaly id: `${site}:${metric}:${bucket}`. A new bucket produces a new id. */
export function anomalyId(siteId: string, anomaly: Anomaly): string {
	return `${siteId}:${anomaly.metric}:${anomaly.bucket}`;
}

const DISMISSED_STORAGE = 'facet.dismissedAnomalies';

function readDismissed(): Set<string> {
	try {
		const raw = localStorage.getItem(DISMISSED_STORAGE);
		if (!raw) return new Set();
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? new Set(parsed.filter((x): x is string => typeof x === 'string'))
			: new Set();
	} catch {
		return new Set();
	}
}

export function isDismissed(id: string): boolean {
	return readDismissed().has(id);
}

export function dismissAnomaly(id: string): void {
	const set = readDismissed();
	set.add(id);
	try {
		localStorage.setItem(DISMISSED_STORAGE, JSON.stringify(Array.from(set)));
	} catch {
		// storage unavailable: dismissal is best-effort only.
	}
}
