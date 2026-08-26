// Tiered granularity for `event_rollups`: hour/day detail is kept for a configurable window, older
// months are additionally summarised as one `month` row, and much older years as one `year` row.
//
// Nothing is deleted. `retention.ts`'s contract that rollups are durable history holds unchanged —
// this job only ADDS coarse rows alongside the fine ones it read.
//
// IMPORTANT: a coarse row is written once and then never recomputed (the source queries anti-join
// against it). That is what keeps `transparency.ts` honest: it hashes a rollup's counters into an
// append-only MMR leaf, so a row whose totals could change after being logged would put the log and
// the table permanently at odds.

import {
	newestBucketStart,
	nextBucketStartAtOrAfter,
	sumFineForPeriod,
	sumMonthsForPeriod,
	writeCoarseRollups,
} from '../db/coarsen.js';
import type { Env } from '../env.js';

/** Three years of hour/day detail before a month is summarised. */
const DEFAULT_ROLLUP_DETAIL_MONTHS = 36;

/** Ten years, after which whole years collapse to a single row each. */
const DEFAULT_ROLLUP_MONTHLY_MONTHS = 120;

/**
 * Periods either tier may fold in one cron invocation. The job runs daily and each period costs a
 * read plus a batched write, so a deployment with a decade of unfolded history makes progress over
 * successive runs instead of attempting it all in one Worker CPU budget.
 */
const MAX_PERIODS_PER_RUN = 12;

/** Months of hour/day detail retained. Validated exactly as `retentionDays()` validates its own var:
 * a positive integer or the default, because zero or negative puts the cutoff at or after `now` and
 * would coarsen the current month on every run. */
function detailMonths(env: Env): number {
	const months = Number.parseInt(env.ROLLUP_DETAIL_MONTHS ?? '', 10);
	return Number.isInteger(months) && months >= 1 ? months : DEFAULT_ROLLUP_DETAIL_MONTHS;
}

/** Months after which a `month` row is folded into a `year` row. Never allowed below the detail
 * window: a year can only be summarised once every one of its months exists, and folding early would
 * write a partial year total that the write-once rule then freezes. */
function monthlyMonths(env: Env): number {
	const months = Number.parseInt(env.ROLLUP_MONTHLY_MONTHS ?? '', 10);
	const value = Number.isInteger(months) && months >= 1 ? months : DEFAULT_ROLLUP_MONTHLY_MONTHS;
	return Math.max(value, detailMonths(env));
}

function utcMonthStart(ts: number): number {
	const d = new Date(ts);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function addMonths(monthStart: number, n: number): number {
	const d = new Date(monthStart);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
}

function utcYearStart(ts: number): number {
	return Date.UTC(new Date(ts).getUTCFullYear(), 0, 1);
}

function addYears(yearStart: number, n: number): number {
	return Date.UTC(new Date(yearStart).getUTCFullYear() + n, 0, 1);
}

/** Fold complete months of hour/day rows into `month` rows. Returns whether the tier is drained —
 * false means the per-run budget ran out with older periods still pending. */
async function foldMonths(env: Env, now: number): Promise<boolean> {
	const cutoff = addMonths(utcMonthStart(now), -detailMonths(env));
	// Resume from the newest month already written rather than rescanning history: that month may
	// have been cut short by the budget mid-(site, hostname), and everything before it is done.
	const newestMonth = await newestBucketStart(env, 'month');
	let period = newestMonth === null ? 0 : utcMonthStart(newestMonth);

	for (let examined = 0; examined < MAX_PERIODS_PER_RUN; examined += 1) {
		// IMPORTANT: jump to the next month that actually HAS source rows. Stepping month by month
		// through a dormant stretch longer than the budget would spend every run re-examining the same
		// empty window, never advance the resume anchor, and strand the year tier behind it forever.
		const nextSource = await nextBucketStartAtOrAfter(env, ['hour', 'day'], period);
		if (nextSource === null) return true;
		period = utcMonthStart(nextSource);
		if (period >= cutoff) return true;
		const next = addMonths(period, 1);
		await writeCoarseRollups(env, 'month', period, await sumFineForPeriod(env, period, next));
		period = next;
	}
	return false;
}

/** Fold complete years of `month` rows into `year` rows. */
async function foldYears(env: Env, now: number): Promise<void> {
	const cutoff = addMonths(utcMonthStart(now), -monthlyMonths(env));
	const newestYear = await newestBucketStart(env, 'year');
	let period = newestYear === null ? 0 : utcYearStart(newestYear);

	for (let examined = 0; examined < MAX_PERIODS_PER_RUN; examined += 1) {
		const nextSource = await nextBucketStartAtOrAfter(env, ['month'], period);
		if (nextSource === null) return;
		period = utcYearStart(nextSource);
		// A year is eligible only once it has ENDED before the cutoff, so every one of its months is
		// already summarised and the year total cannot be frozen at a partial sum.
		if (addYears(period, 1) > cutoff) return;
		const next = addYears(period, 1);
		await writeCoarseRollups(env, 'year', period, await sumMonthsForPeriod(env, period, next));
		period = next;
	}
}

/**
 * Daily cron entry point. Month tier first; the year tier reads what it produces, so it is skipped
 * entirely while the month tier is still catching up — otherwise a year could be summed from a
 * half-written set of months and the write-once rule would make that permanent.
 */
export async function coarsenRollups(env: Env, now: number): Promise<void> {
	const monthsDrained = await foldMonths(env, now);
	if (!monthsDrained) return;
	await foldYears(env, now);
}
