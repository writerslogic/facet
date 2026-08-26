// Cadence expressions for scheduled jobs. The Worker cron trigger is hourly, so whole hours are the
// only meaningful resolution and the grammar is deliberately just `<hours>h` — no cron syntax.

import { HOUR_MS } from './constants.js';

export type CadenceParse = { ok: true; ms: number } | { ok: false; error: string };

// Leading digit 1-9 rejects `0h` (a zero period makes the occurrence NaN) and zero-padded forms;
// the unit `h` rejects sub-hour cadences the hourly trigger could never honour.
const CADENCE_RE = /^([1-9][0-9]{0,3})h$/;

export function parseCadence(expr: string): CadenceParse {
	const match = CADENCE_RE.exec(expr);
	if (!match) {
		return {
			ok: false,
			error: `invalid cadence "${expr.slice(0, 32)}": expected <hours>h, 1h-9999h`,
		};
	}
	return { ok: true, ms: Number(match[1]) * HOUR_MS };
}

/** The start of the cadence window `now` falls in; the unit a run is recorded against. */
export function occurrenceOf(now: number, cadenceMs: number): number {
	return Math.floor(now / cadenceMs) * cadenceMs;
}
