// Number/duration formatting and period-comparison delta math shared across KPI cards.

const numberFormat = new Intl.NumberFormat('en-US');
const compactFormat = new Intl.NumberFormat('en-US', {
	notation: 'compact',
	maximumFractionDigits: 1,
});
const percentFormat = new Intl.NumberFormat('en-US', {
	style: 'percent',
	maximumFractionDigits: 1,
});

export function formatNumber(value: number): string {
	return numberFormat.format(value);
}

export function formatCompact(value: number): string {
	return compactFormat.format(value);
}

export function formatPercent(value: number): string {
	return percentFormat.format(value);
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Whether a rising value is good ("up"), a falling value is good ("down"), or neither ("neutral"). */
export type MetricDirection = 'up' | 'down' | 'neutral';

/** Whether a delta represents an improvement, a regression, or neither (given the metric's direction). */
export type DeltaSense = 'improvement' | 'regression' | 'neutral';

export interface Delta {
	/** current - previous. */
	absolute: number;
	/** Fractional change vs previous, or null when the previous value was zero (avoids Infinity/NaN). */
	pct: number | null;
	/** True when there was no previous value to compare against. */
	isNew: boolean;
	sense: DeltaSense;
}

/**
 * Compute the delta of `current` vs `previous`. A zero previous value yields `pct: null` (never
 * Infinity/NaN); `isNew` flags a jump from nothing to something. `direction` decides whether a rise
 * or fall counts as an improvement.
 */
export function computeDelta(
	current: number,
	previous: number,
	direction: MetricDirection = 'up',
): Delta {
	const absolute = current - previous;
	const isNew = previous === 0 && current !== 0;
	const pct = previous === 0 ? null : absolute / previous;

	let sense: DeltaSense = 'neutral';
	if (direction !== 'neutral' && absolute !== 0) {
		const rose = absolute > 0;
		const good = direction === 'up' ? rose : !rose;
		sense = good ? 'improvement' : 'regression';
	}

	return { absolute, pct, isNew, sense };
}

/** Human label for a delta's percent change: signed percent, "new", or "—" for no change. */
export function formatDeltaPct(delta: Delta): string {
	if (delta.isNew) return 'new';
	if (delta.pct === null) return '—';
	if (delta.absolute === 0) return '—';
	const sign = delta.pct > 0 ? '+' : '';
	return `${sign}${percentFormat.format(delta.pct)}`;
}
