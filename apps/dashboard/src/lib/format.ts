// Number/duration formatting and period-comparison delta math shared across KPI cards.
//
// LOCALE: every formatter here used to be pinned to `'en-US'`, so a German operator read their own
// deployment's traffic as "1,234,567" — a number that means one thousand two hundred and thirty-four
// to them. Nothing names a locale now; `uiLocale()` resolves the visitor's (see lib/datetime.ts, which
// makes the same choice for dates). Formatters are memoized per locale because these run inside chart
// axis callbacks.

import { uiLocale } from './datetime.js';

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(key: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
	const locale = uiLocale();
	const id = `${key}|${locale ?? ''}`;
	const hit = numberFormats.get(id);
	if (hit) return hit;
	const made = new Intl.NumberFormat(locale, options);
	numberFormats.set(id, made);
	return made;
}

export function formatNumber(value: number): string {
	return numberFormat('plain').format(value);
}

export function formatCompact(value: number): string {
	return numberFormat('compact', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatPercent(value: number): string {
	return numberFormat('percent', { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

/** One decimal place, for rates that are not percentages (pages per session). */
export function formatDecimal(value: number): string {
	return numberFormat('decimal', {
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(value);
}

/**
 * Above this, a figure stops being readable at a glance in a fixed-width tile: "1,234,567" in a 4xl
 * face either overflows or shrinks the whole row to fit its widest member.
 */
export const COMPACT_ABOVE = 100_000;

/**
 * The rule for compact notation, in one place so it is a decision and not a habit.
 *
 * USE IT for a headline figure in a fixed-width tile, where the job of the number is "how big, at a
 * glance" and the exact value is one hover away. DO NOT use it for anything a reader will copy into a
 * report or a spreadsheet — table cells, Ask answers, exports, the "why flagged" evidence on an
 * anomaly. "1.2M" is not a number you can reconcile against anything, and rounding a figure someone
 * is about to quote is a worse failure than making them read seven digits.
 *
 * Below the threshold the exact value is returned, because "84,120" is perfectly legible and "84.1K"
 * is strictly less information for the same width.
 */
export function formatKpi(value: number): string {
	return Math.abs(value) >= COMPACT_ABOVE ? formatCompact(value) : formatNumber(value);
}

/** The exact value, for the `title` of anything rendered through `formatKpi`. Returns null when the
 * figure was not abbreviated, so a caller adds no redundant tooltip. */
export function exactHint(value: number): string | null {
	return Math.abs(value) >= COMPACT_ABOVE ? formatNumber(value) : null;
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
	return `${sign}${formatPercent(delta.pct)}`;
}

// ---------------------------------------------------------------------------
// Movement: the one period-over-period model every surface renders through
//
// Before this existed the dashboard had three unrelated delta treatments — KpiCard's badge, the
// funnel's inline "+8.0 pts", and nothing at all on the breakdown lists — each with its own idea of
// sign, colour and wording. `Movement` is the single value type: it carries WHICH UNIT the change
// should be read in, because that is the part a reader gets wrong. Two rates differ by percentage
// POINTS; two counts differ by percent; a count with almost nothing behind it differs by neither and
// is only honestly reported as an absolute. Nothing here can represent "unknown" — an unavailable
// comparison is `null`, so a surface that has no honest number renders no badge at all.

/**
 * `pct`     — count vs count, as a fraction (0.12 → "+12%").
 * `points`  — rate vs rate, in fractional percentage points (0.08 → "+8.0 pts").
 * `count`   — an absolute change, used when the prior base is too small for a percentage.
 * `new`     — nothing in the preceding period, something now.
 * `gone`    — something in the preceding period, nothing now.
 * `entered` — appeared in a top-N list that the preceding period's list may have truncated: the rise
 *             is certain, its size is not (see lib/compare.ts).
 */
export type MovementKind = 'pct' | 'points' | 'count' | 'new' | 'gone' | 'entered';

export interface Movement {
	kind: MovementKind;
	/** Signed magnitude in the kind's own units; 0 for `new`/`gone`/`entered`, which carry their
	 * meaning in the kind rather than a number. */
	value: number;
	sense: DeltaSense;
	/** Why this shape was chosen (e.g. "only 4 last period"), appended to the badge's tooltip. */
	detail?: string;
}

/**
 * Below this many prior observations a percentage stops meaning anything: at a base of 10 a single
 * extra visit reads as "+10%", and at a base of 2 as "+50%". Such rows report their absolute change
 * instead — smaller-looking, but the only number that is actually true.
 */
export const LOW_VOLUME_BASE = 20;

/** Improvement/regression from the sign of a change and the metric's preferred direction. */
export function senseOf(change: number, direction: MetricDirection = 'up'): DeltaSense {
	if (direction === 'neutral' || change === 0) return 'neutral';
	const good = direction === 'up' ? change > 0 : change < 0;
	return good ? 'improvement' : 'regression';
}

/**
 * Count-vs-count movement, or null when there is nothing honest to say. `previous` of `null`/
 * `undefined` means "no comparison window" (never "zero") and yields null — the caller renders no
 * badge rather than inventing a rise from nothing.
 */
export function countMovement(
	current: number,
	previous: number | null | undefined,
	direction: MetricDirection = 'up',
): Movement | null {
	if (previous == null || !Number.isFinite(previous) || !Number.isFinite(current)) return null;
	const change = current - previous;
	if (previous === 0 && current === 0) return null;
	if (previous === 0) return { kind: 'new', value: 0, sense: senseOf(1, direction) };
	if (current === 0) return { kind: 'gone', value: 0, sense: senseOf(-1, direction) };
	if (previous < LOW_VOLUME_BASE) {
		return {
			kind: 'count',
			value: change,
			sense: senseOf(change, direction),
			detail: `only ${formatNumber(previous)} in the preceding period — too few for a percentage`,
		};
	}
	return { kind: 'pct', value: change / previous, sense: senseOf(change, direction) };
}

/**
 * Rate-vs-rate movement in percentage points. Both rates are fractions (0..1). Null when either side
 * is missing — a rate over an empty base does not exist, and subtracting from it would invent one.
 */
export function rateMovement(
	current: number | null | undefined,
	previous: number | null | undefined,
	direction: MetricDirection = 'up',
): Movement | null {
	if (current == null || previous == null) return null;
	if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
	const change = current - previous;
	return { kind: 'points', value: change, sense: senseOf(change, direction) };
}

/**
 * Signed percentage-point change ("+8.0 pts"). Rate-vs-rate movement is points, not percent — a 40%
 * step rising to 48% is +8 pts, and calling that "+20%" is the classic funnel misread. Moved here
 * from FunnelChart once a second surface (goal conversions, then experiments) needed it.
 */
export function formatPoints(delta: number): string {
	const pts = Number((delta * 100).toFixed(1));
	if (pts === 0) return '±0.0 pts';
	return `${pts > 0 ? '+' : '−'}${Math.abs(pts).toFixed(1)} pts`;
}

/** Signed count with a real minus sign, for "+120" / "−45" deltas. */
export function formatSignedCount(value: number): string {
	if (value === 0) return '±0';
	return `${value > 0 ? '+' : '−'}${formatNumber(Math.abs(value))}`;
}

/**
 * The text a movement renders as. One rule per kind, used by every surface via `DeltaBadge`.
 *
 * Rounding decides the sign, not the raw value: a change of 0.004% prints as "±0%", so it must not
 * print as "+0%" either. `±` is therefore the marker for "no visible change", and `DeltaBadge` reads
 * it back to choose the flat icon and the neutral colour — which is how text, arrow and colour are
 * kept from ever disagreeing about direction.
 */
export function movementLabel(movement: Movement): string {
	switch (movement.kind) {
		case 'new':
			return 'new';
		case 'gone':
			return 'gone';
		case 'entered':
			return 'entered';
		case 'points':
			return formatPoints(movement.value);
		case 'count':
			return formatSignedCount(movement.value);
		case 'pct': {
			// Rounded to the same 0.1% the formatter prints, so "+0%" can never appear.
			const rounded = Number((movement.value * 100).toFixed(1));
			if (rounded === 0) return '±0%';
			return `${rounded > 0 ? '+' : '−'}${formatPercent(Math.abs(movement.value))}`;
		}
	}
}

/** True when a movement rounds to no visible change — the one source of "flat" for every surface. */
export function movementIsFlat(movement: Movement): boolean {
	return movementLabel(movement).startsWith('±');
}

/** The sentence behind a movement's `title`, so the badge is never a bare number without provenance. */
export function movementTitle(movement: Movement): string {
	const base =
		movement.kind === 'new'
			? 'Not present in the equal-length preceding period'
			: movement.kind === 'gone'
				? 'Present in the equal-length preceding period, absent now'
				: movement.kind === 'entered'
					? "Above the preceding period's top list, which did not include this key — the rise is certain, its size is not"
					: 'Change vs the equal-length preceding period';
	return movement.detail ? `${base} (${movement.detail})` : base;
}

/** Movement direction as a word, so colour is never the only carrier of meaning. */
export function movementSenseLabel(movement: Movement): string {
	if (movement.sense === 'improvement') return 'improved';
	if (movement.sense === 'regression') return 'worsened';
	return 'unchanged';
}

/** Bridge the older `Delta` (KPI cards, All sites) onto the shared movement model. */
export function toMovement(delta: Delta): Movement {
	if (delta.isNew) return { kind: 'new', value: 0, sense: delta.sense };
	if (delta.pct === null) return { kind: 'count', value: delta.absolute, sense: delta.sense };
	return { kind: 'pct', value: delta.pct, sense: delta.sense };
}
