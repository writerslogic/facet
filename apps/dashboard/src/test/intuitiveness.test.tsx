// The micro-detail layer: locale, clock, and the keyboard.
//
// Three defects are pinned here, each of which shipped and each of which is invisible to a US-English
// reader on a US-English machine:
//
//   1. Every date and number formatter named `'en-US'`. A German operator read their own deployment's
//      traffic as "1,234,567" — a figure that means one and a bit to them.
//   2. Half the app rendered UTC and half rendered the browser's timezone, with nothing saying which.
//   3. There was no keyboard layer, and the one shortcut that existed (⌥1..9) fired while you were
//      typing into a text field.
//
// DETERMINISM: nothing here asserts a string the host's timezone could change. Either the clock is
// pinned to UTC (which forces `timeZone: 'UTC'` into every formatter), or the expectation is derived
// the same way a browser would derive it, so the assertion holds in any zone.

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	clockLabel,
	clockZone,
	formatDateTimeInput,
	formatDay,
	formatDayShort,
	formatHourWindow,
	formatIso,
	formatStamp,
	formatWindowLabel,
	getClockMode,
	parseDateTimeInput,
	setClockMode,
	toggleClockMode,
	uiLocale,
} from '../lib/datetime.js';
import { COMPACT_ABOVE, exactHint, formatKpi, formatNumber } from '../lib/format.js';
import { ASK_INPUT_ID, SHORTCUTS, isTypingTarget, matchShortcut } from '../lib/shortcuts.js';

const JULY_30 = Date.UTC(2026, 6, 30, 14, 0, 0);

/**
 * Run `body` as if the browser were set to `locale`. `navigator.language` is what `uiLocale()` reads,
 * and it is what a real non-English visitor differs by — so this is the actual production input, not
 * a stand-in for it.
 */
function withLocale<T>(locale: string, body: () => T): T {
	const language = Object.getOwnPropertyDescriptor(navigator, 'language');
	const languages = Object.getOwnPropertyDescriptor(navigator, 'languages');
	Object.defineProperty(navigator, 'language', { value: locale, configurable: true });
	Object.defineProperty(navigator, 'languages', { value: [locale], configurable: true });
	try {
		return body();
	} finally {
		if (language) Object.defineProperty(navigator, 'language', language);
		else Reflect.deleteProperty(navigator, 'language');
		if (languages) Object.defineProperty(navigator, 'languages', languages);
		else Reflect.deleteProperty(navigator, 'languages');
	}
}

/** Run `body` with the clock pinned, restoring the default afterwards. */
function withClock<T>(mode: 'local' | 'utc', body: () => T): T {
	const before = getClockMode();
	setClockMode(mode);
	try {
		return body();
	} finally {
		setClockMode(before);
	}
}

afterEach(() => {
	setClockMode('local');
	vi.restoreAllMocks();
});

// =================================================================================================
// 1. Locale. THE REQUIRED PROOF: a date rendered under a non-en-US locale is not American-formatted.
// =================================================================================================

describe('dates and numbers follow the visitor’s locale, not en-US', () => {
	it('renders a German visitor’s date in German, not American', () => {
		const german = withClock('utc', () => withLocale('de-DE', () => formatDay(JULY_30)));
		// The positive assertion: this is what a de-DE browser produces for these options.
		expect(german).toBe('30. Juli 2026');
		// The negative one, which is the actual regression guard — "Jul 30, 2026" is the string the
		// hardcoded `toLocaleDateString('en-US', …)` produced for every visitor on Earth.
		expect(german).not.toBe('Jul 30, 2026');
		expect(german).not.toMatch(/Jul(?!i)/);
	});

	it('renders a Japanese visitor’s date in Japanese', () => {
		const japanese = withClock('utc', () => withLocale('ja-JP', () => formatDay(JULY_30)));
		expect(japanese).toBe('2026年7月30日');
	});

	it('formats numbers in the visitor’s locale', () => {
		// German groups with '.' and decimalises with ',' — the exact inversion of en-US, which is
		// why a hardcoded en-US number is not merely unfamiliar to a German reader but wrong.
		expect(withLocale('de-DE', () => formatNumber(1234567))).toBe('1.234.567');
		expect(withLocale('en-US', () => formatNumber(1234567))).toBe('1,234,567');
	});

	it('resolves the locale live, so a formatter is never captured at import time', () => {
		expect(withLocale('fr-FR', () => uiLocale())).toBe('fr-FR');
		expect(withLocale('de-DE', () => uiLocale())).toBe('de-DE');
		// Two different locales in one process must produce two different strings — the memoized
		// formatters are keyed on locale, and this is the assertion that keeps them that way.
		expect(withClock('utc', () => withLocale('fr-FR', () => formatDayShort(JULY_30)))).not.toBe(
			withClock('utc', () => withLocale('de-DE', () => formatDayShort(JULY_30))),
		);
	});
});

// =================================================================================================
// 2. One clock, stated. Local by default, UTC on demand, never unlabelled.
// =================================================================================================

describe('every timestamp names the clock it is in', () => {
	it('defaults to the visitor’s own timezone', () => {
		expect(getClockMode()).toBe('local');
		expect(clockZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
	});

	it('labels UTC as UTC and local as the visitor’s zone abbreviation', () => {
		expect(withClock('utc', () => clockLabel())).toBe('UTC');
		const local = clockLabel();
		const expected =
			new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
				.formatToParts(Date.now())
				.find((part) => part.type === 'timeZoneName')?.value ?? clockZone();
		expect(local).toBe(expected);
	});

	it('suffixes every absolute stamp with its clock — never a bare timestamp', () => {
		expect(withClock('utc', () => formatStamp(JULY_30))).toBe('Jul 30, 14:00 UTC');
		expect(formatStamp(JULY_30).endsWith(clockLabel())).toBe(true);
		expect(formatWindowLabel(0, 1000, false).endsWith(clockLabel())).toBe(true);
		expect(formatHourWindow(JULY_30, JULY_30 + 3_600_000).absolute.endsWith(clockLabel())).toBe(
			true,
		);
	});

	it('moves only the presentation — the machine-readable instant is clock-independent', () => {
		const utc = withClock('utc', () => formatHourWindow(JULY_30, JULY_30 + 3_600_000));
		const local = formatHourWindow(JULY_30, JULY_30 + 3_600_000);
		expect(utc.iso).toBe(local.iso);
		expect(formatIso(JULY_30)).toBe('2026-07-30T14:00:00.000Z');
	});

	it('round-trips timeline form instants in either selected clock', () => {
		expect(
			withClock('utc', () => parseDateTimeInput(formatDateTimeInput(JULY_30), 'utc')),
		).toBe(JULY_30);
		expect(parseDateTimeInput(formatDateTimeInput(JULY_30, 'local'), 'local')).toBe(JULY_30);
	});

	it('composes the hour window itself, so a locale’s own date-time pattern cannot break it', () => {
		// The previous implementation formatted date+time as one string and split it on ", " to peel
		// the date off the second half. de-DE, ja-JP and fr-FR all join them differently, so that
		// split silently produced garbage outside en-US. Composed from two formatters, it cannot.
		const german = withClock('utc', () =>
			withLocale('de-DE', () => formatHourWindow(JULY_30, JULY_30 + 3_600_000).absolute),
		);
		expect(german).toBe('30. Juli, 14:00–15:00 UTC');
		const crossMidnight = withClock(
			'utc',
			() => formatHourWindow(Date.UTC(2026, 6, 30, 23), Date.UTC(2026, 6, 31, 0)).absolute,
		);
		expect(crossMidnight).toBe('Jul 30, 23:00 – Jul 31, 00:00 UTC');
	});

	it('toggles between exactly two clocks and persists the choice', () => {
		toggleClockMode();
		expect(getClockMode()).toBe('utc');
		expect(localStorage.getItem('facet.clock')).toBe('utc');
		toggleClockMode();
		expect(getClockMode()).toBe('local');
	});
});

// =================================================================================================
// 3. The keyboard layer, and above all its safety rules.
// =================================================================================================

/** Build a KeyboardEvent the matcher will see exactly as the browser delivers it. */
function keyEvent(key: string, init: KeyboardEventInit & { target?: Element } = {}): KeyboardEvent {
	// `cancelable` matters: `preventDefault()` on a non-cancelable event is a no-op, so without it
	// the "another handler already consumed this" case below would silently assert nothing.
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	if (init.target) Object.defineProperty(event, 'target', { value: init.target });
	return event;
}

describe('keyboard shortcuts: the safety rules', () => {
	// THE REQUIRED PROOF. Single-key shortcuts are only defensible because of this rule; without it
	// typing "a range of 30 days" into the Ask box would switch tabs four times and change the range.
	it('does NOT fire when a shortcut key is typed into a focused text input', () => {
		render(<input id={ASK_INPUT_ID} type="text" aria-label="Question" />);
		const input = screen.getByLabelText('Question') as HTMLInputElement;
		input.focus();
		expect(document.activeElement).toBe(input);

		for (const shortcut of SHORTCUTS) {
			for (const key of shortcut.keys) {
				expect(matchShortcut(keyEvent(key, { target: input }))).toBeNull();
			}
		}

		// And the character actually reaches the field, which is the user-visible half of the claim.
		fireEvent.change(input, { target: { value: '?' } });
		expect(input.value).toBe('?');
	});

	it('does not fire in a textarea, a select, or a contenteditable region', () => {
		render(
			<>
				<textarea aria-label="Notes" />
				<div
					aria-label="Rich"
					contentEditable
					role="textbox"
					tabIndex={0}
					suppressContentEditableWarning
				/>
				<select aria-label="Pick">
					<option>a</option>
				</select>
			</>,
		);
		for (const label of ['Notes', 'Rich', 'Pick']) {
			const element = screen.getByLabelText(label);
			expect(isTypingTarget(element)).toBe(true);
			expect(matchShortcut(keyEvent('?', { target: element }))).toBeNull();
		}
	});

	it('does fire from a non-typing element — a button is not a text field', () => {
		render(<button type="button">Go</button>);
		const button = screen.getByRole('button');
		expect(isTypingTarget(button)).toBe(false);
		expect(matchShortcut(keyEvent('?', { target: button }))).toBe('help');
	});

	it('never claims a key the browser or the OS owns', () => {
		for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
			expect(matchShortcut(keyEvent('1', { [modifier]: true }))).toBeNull();
		}
		// Alt in particular is reserved: ⌥1..9 is the site switcher's, and predates this layer.
		expect(matchShortcut(keyEvent('2', { altKey: true }))).toBeNull();
	});

	it('ignores auto-repeat, IME composition, and keys another handler consumed', () => {
		expect(matchShortcut(keyEvent('1', { repeat: true }))).toBeNull();
		expect(matchShortcut(keyEvent('1', { isComposing: true }))).toBeNull();
		const consumed = keyEvent('1');
		consumed.preventDefault();
		expect(matchShortcut(consumed)).toBeNull();
	});

	it('resolves the documented keys, and only those', () => {
		expect(matchShortcut(keyEvent('?'))).toBe('help');
		expect(matchShortcut(keyEvent('1'))).toBe('range-24h');
		expect(matchShortcut(keyEvent('4'))).toBe('range-90d');
		expect(matchShortcut(keyEvent('['))).toBe('tab-prev');
		expect(matchShortcut(keyEvent(']'))).toBe('tab-next');
		expect(matchShortcut(keyEvent('a'))).toBe('go-ask');
		expect(matchShortcut(keyEvent('T'))).toBe('toggle-clock');
		// Not claimed: anything not in the table, and nothing that would shadow page scrolling.
		for (const key of [' ', 'PageDown', 'Home', 'End', 'z', '/', "'"]) {
			expect(matchShortcut(keyEvent(key))).toBeNull();
		}
	});
});

describe('keyboard shortcuts: the table is the documentation', () => {
	it('assigns every key to exactly one action', () => {
		const seen = new Map<string, string>();
		for (const shortcut of SHORTCUTS) {
			for (const key of shortcut.keys) {
				expect(seen.get(key)).toBeUndefined();
				seen.set(key, shortcut.id);
			}
		}
	});

	it('gives every shortcut a printable key and a description for the overlay', () => {
		for (const shortcut of SHORTCUTS) {
			expect(shortcut.display.length).toBeGreaterThan(0);
			expect(shortcut.label.length).toBeGreaterThan(0);
			expect(shortcut.keys.length).toBeGreaterThan(0);
		}
	});
});

// =================================================================================================
// 4. Compact notation is a decision, not a habit.
// =================================================================================================

describe('compact notation is applied where it helps and nowhere else', () => {
	it('keeps a figure exact until it stops being readable at a glance', () => {
		expect(formatKpi(9999)).toBe(formatNumber(9999));
		expect(formatKpi(84_120)).toBe('84,120');
		expect(exactHint(84_120)).toBeNull();
	});

	it('abbreviates past the threshold and keeps the exact value available', () => {
		expect(formatKpi(1_234_567)).toBe('1.2M');
		expect(exactHint(1_234_567)).toBe('1,234,567');
		expect(formatKpi(COMPACT_ABOVE)).toBe('100K');
	});

	it('abbreviates negatives by magnitude, not by sign', () => {
		expect(formatKpi(-1_234_567)).toBe('-1.2M');
		expect(exactHint(-50)).toBeNull();
	});
});
