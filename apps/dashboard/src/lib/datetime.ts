// The one clock, and the one locale.
//
// WHY THIS EXISTS — two defects it fixes at once:
//
// 1. LOCALE. Five surfaces called `toLocaleDateString('en-US', …)` and three built
//    `Intl.*Format('en-US')`. A German or Japanese operator read "Jul 30" and "1,234,567" on their
//    own deployment. Nothing here ever names a locale: every formatter resolves the VISITOR's, via
//    `uiLocale()`.
//
// 2. TWO CLOCKS, UNLABELLED. Roughly seven surfaces rendered UTC (`toUTCString`/`toISOString`) and
//    six rendered the browser's timezone (`toLocale*`), side by side, with nothing saying which was
//    which — an anomaly hour in UTC directly above an experiment start date in local time.
//
//    THE PRODUCT ANSWER: **render in the visitor's own timezone by default, say so once and
//    unmistakably, and offer a UTC switch.** Local is what a human means by "yesterday at 9". UTC is
//    what an operator needs when comparing against server logs — and the server is UTC everywhere and
//    deliberately refuses to guess a site's timezone (see `GET /api/stats/clock`), so UTC has to stay
//    one keystroke away rather than being the silent default nobody was told about.
//
//    The mode is global (module state + subscription, not context) because half the callers are not
//    React: uPlot axis/tooltip callbacks, `lib/anomaly.ts`, the clipboard text builder. `useClockMode`
//    is the React face of the same value, so a toggle re-renders every surface at once.
//
// One rule for the whole app: no component calls `toLocale*String` or `toUTC*String` directly. If a
// timestamp reaches a screen, it came through this file, and it is stamped with the clock it is in.

import { useSyncExternalStore } from 'react';

/** Which clock every timestamp on screen is rendered in. */
export type ClockMode = 'local' | 'utc';

const STORAGE_KEY = 'facet.clock';

function readStored(): ClockMode {
	try {
		return localStorage.getItem(STORAGE_KEY) === 'utc' ? 'utc' : 'local';
	} catch {
		// Storage can be unavailable (private mode, embedded webview). Default, don't crash.
		return 'local';
	}
}

let mode: ClockMode = readStored();
const listeners = new Set<() => void>();

export function getClockMode(): ClockMode {
	return mode;
}

/** Set the clock, persist the choice, and re-render every subscriber. */
export function setClockMode(next: ClockMode): void {
	if (next === mode) return;
	mode = next;
	try {
		localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// Best effort: the session still honours the choice even if it can't be remembered.
	}
	for (const listener of [...listeners]) listener();
}

export function toggleClockMode(): void {
	setClockMode(mode === 'utc' ? 'local' : 'utc');
}

export function subscribeClock(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The active clock, as React state. Any component rendering a timestamp must call this so the
 * header toggle actually moves it. */
export function useClockMode(): ClockMode {
	return useSyncExternalStore(subscribeClock, getClockMode, getClockMode);
}

/**
 * The visitor's locale, or undefined when there is no navigator (SSR/tests) — `undefined` makes Intl
 * fall back to the runtime default, which is the right answer in both cases. Read live rather than
 * captured at module load: a browser can change it, and a test must be able to.
 */
export function uiLocale(): string | undefined {
	if (typeof navigator === 'undefined') return undefined;
	const nav = navigator as Navigator & { languages?: readonly string[] };
	return nav.languages?.[0] ?? nav.language ?? undefined;
}

// Intl formatter construction is expensive enough to matter inside a uPlot axis callback, so they are
// memoized — keyed on locale AND mode, which is what makes both switchable at runtime.
const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormat(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const locale = uiLocale();
	const id = `${key}|${locale ?? ''}|${mode}`;
	const hit = formatters.get(id);
	if (hit) return hit;
	const made = new Intl.DateTimeFormat(
		locale,
		mode === 'utc' ? { ...options, timeZone: 'UTC' } : options,
	);
	formatters.set(id, made);
	return made;
}

// Hour-aligned data timestamps use a 24-hour clock in every locale, on purpose: an hour WINDOW
// ("14:00–15:00") is unreadable as "02:00 PM–03:00 PM", and these line up against server logs that
// are 24-hour too. Locale still decides month name, field order and separators — which is the part
// an `en-US` hardcode was actually getting wrong.
const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
	hour: '2-digit',
	minute: '2-digit',
	hour12: false,
};

/** IANA zone the clock is currently in ("UTC" or e.g. "Europe/Berlin"), for the toggle's tooltip. */
export function clockZone(): string {
	if (mode === 'utc') return 'UTC';
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/**
 * The short name every timestamp is suffixed with — "UTC", or the visitor's zone abbreviation
 * ("PDT", "MESZ", "GMT+9"). This is the label that makes the clock stated rather than implied, so it
 * is never omitted from an absolute timestamp.
 */
export function clockLabel(): string {
	if (mode === 'utc') return 'UTC';
	const parts = dateFormat('zone', { timeZoneName: 'short' }).formatToParts(Date.now());
	return parts.find((part) => part.type === 'timeZoneName')?.value ?? clockZone();
}

/** Date with year: "Jul 30, 2026" · "30. Juli 2026" · "2026年7月30日". */
export function formatDay(ms: number): string {
	return dateFormat('day', { year: 'numeric', month: 'short', day: 'numeric' }).format(ms);
}

/** Date without year, for axis ticks and same-year windows: "Jul 30" · "30. Juli". */
export function formatDayShort(ms: number): string {
	return dateFormat('dayShort', { month: 'short', day: 'numeric' }).format(ms);
}

/** Time of day only: "14:32". */
export function formatTimeOfDay(ms: number): string {
	return dateFormat('time', TIME_OPTIONS).format(ms);
}

/** Date + time, no zone suffix: "Jul 30, 14:32". Composed from two formatters rather than one
 * combined pattern so the comma is ours and never a locale's, which is what lets callers split the
 * two halves apart (see `formatHourWindow`). */
export function formatDateTime(ms: number): string {
	return `${formatDayShort(ms)}, ${formatTimeOfDay(ms)}`;
}

/** A full, self-describing instant: "Jul 30, 14:32 UTC". The form used anywhere a number is being
 * attributed to a moment (chart readouts, "last updated"). */
export function formatStamp(ms: number): string {
	return `${formatDateTime(ms)} ${clockLabel()}`;
}

/** Machine-readable instant for a `<time datetime>` attribute. Always UTC/ISO — the attribute is for
 * assistive tech and parsers, not for reading, and an offset-free instant is unambiguous. */
export function formatIso(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * A `[start, end)` window as one label, in the active clock and always suffixed with it.
 * `withTime` renders the times too (short windows), otherwise just the days.
 */
export function formatWindowLabel(start: number, end: number, withTime: boolean): string {
	const render = withTime ? formatDateTime : formatDayShort;
	return `${render(start)} – ${render(end)} ${clockLabel()}`;
}

/** Compact "how long ago" duration ("45s" / "2m"): seconds under 90, minutes above. Locale-aware via
 * `Intl.NumberFormat`'s unit style, so the unit letter follows the visitor's language rather than a
 * hardcoded "s"/"min" suffix. Named `formatElapsed`, not `formatDuration`, to stay distinct from
 * `lib/format.ts`'s `formatDuration` (a "M:SS" session-length clock — a different shape entirely). */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const useMinutes = seconds >= 90;
	const value = useMinutes ? Math.round(seconds / 60) : seconds;
	return new Intl.NumberFormat(uiLocale(), {
		style: 'unit',
		unit: useMinutes ? 'minute' : 'second',
		unitDisplay: 'narrow',
	}).format(value);
}

export interface HourWindow {
	/** ISO instant of the window start, for `<time datetime>`. */
	iso: string;
	/** "Jul 30, 14:00–15:00 UTC", or both dates when the window crosses midnight. */
	absolute: string;
}

/**
 * An hour-aligned window. The date and the time are formatted separately and joined here, so this is
 * correct in locales whose combined date-time pattern is not "<date>, <time>" (de, ja, fr all differ)
 * — the previous implementation split the formatted string on ", " and silently produced nonsense
 * outside en-US.
 */
export function formatHourWindow(start: number, end: number): HourWindow {
	const startDay = formatDayShort(start);
	const endDay = formatDayShort(end);
	const startTime = formatTimeOfDay(start);
	const endTime = formatTimeOfDay(end);
	const zone = clockLabel();
	return {
		iso: formatIso(start),
		absolute:
			startDay === endDay
				? `${startDay}, ${startTime}–${endTime} ${zone}`
				: `${startDay}, ${startTime} – ${endDay}, ${endTime} ${zone}`,
	};
}
