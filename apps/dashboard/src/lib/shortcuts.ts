// The keyboard layer: one table of shortcuts, and the matcher that decides when a keypress is one.
//
// WHY THIS EXISTS: the app had exactly one shortcut (⌥1..9 for sites) and no way to discover it. An
// analytics dashboard is a thing people live in all day; every range change and tab switch was a
// mouse trip.
//
// WHY IT IS A TABLE AND NOT A PILE OF `onKeyDown`s: the `?` overlay is generated FROM this array, so
// a shortcut that exists but is undocumented is not expressible. That is the whole design — the
// discovery mechanism cannot drift from the behaviour.
//
// THE FOUR SAFETY RULES, all enforced in `matchShortcut` (not by each caller):
//   1. Never while text is being entered. An input, textarea, select, contenteditable or a widget
//      with a textbox-family role owns every key it receives. `?` in the Ask box types a question
//      mark; it does not open an overlay. This is the rule that makes single-key shortcuts legal.
//   2. Never with Ctrl/Cmd/Alt. Those spaces belong to the browser and the OS — and Alt specifically
//      already belongs to the site switcher's ⌥1..9, which is why nothing here claims a modifier.
//   3. Never on auto-repeat or mid-IME-composition. A held key is not nine range changes, and a key
//      that is part of composing Japanese text is not a command.
//   4. Never a key another handler already consumed (`defaultPrevented`).
//
// SCREEN READERS: browse mode intercepts single letters/digits before the page ever sees them, so
// these cannot shadow a screen-reader quick-nav key — the reader wins, and the shortcut simply does
// not fire. Nothing here is the only route to any action: every shortcut has a visible control.

/**
 * DOM id of the Ask question box. It lives here rather than in `AskPanel` because the shortcut
 * handler in `App` needs it, and importing it from the panel would pull that whole code-split tab
 * into the initial bundle — an eagerly-loaded Ask tab is a real cost for one string constant.
 */
export const ASK_INPUT_ID = 'facet-ask-question';

/** Every action the keyboard can reach. */
export type ShortcutId =
	| 'help'
	| 'range-24h'
	| 'range-7d'
	| 'range-30d'
	| 'range-90d'
	| 'tab-prev'
	| 'tab-next'
	| 'go-overview'
	| 'go-realtime'
	| 'go-ask'
	| 'clear-segment'
	| 'toggle-clock';

export type ShortcutGroup = 'Getting around' | 'Date range' | 'Filtering & display' | 'Help';

export interface Shortcut {
	id: ShortcutId;
	/** `KeyboardEvent.key` values that fire it. */
	keys: readonly string[];
	/** How the key is printed in the overlay and in the docs. */
	display: string;
	label: string;
	group: ShortcutGroup;
}

/** Group order in the overlay: what you reach for most, first. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
	'Getting around',
	'Date range',
	'Filtering & display',
	'Help',
];

export const SHORTCUTS: readonly Shortcut[] = [
	{
		id: 'tab-prev',
		keys: ['['],
		display: '[',
		label: 'Previous tab',
		group: 'Getting around',
	},
	{
		id: 'tab-next',
		keys: [']'],
		display: ']',
		label: 'Next tab',
		group: 'Getting around',
	},
	{
		id: 'go-overview',
		keys: ['o', 'O'],
		display: 'O',
		label: 'Overview',
		group: 'Getting around',
	},
	{
		id: 'go-realtime',
		keys: ['r', 'R'],
		display: 'R',
		label: 'Realtime',
		group: 'Getting around',
	},
	{
		id: 'go-ask',
		keys: ['a', 'A'],
		display: 'A',
		label: 'Ask — opens the tab and puts the cursor in the question box',
		group: 'Getting around',
	},
	{ id: 'range-24h', keys: ['1'], display: '1', label: 'Last 24 hours', group: 'Date range' },
	{ id: 'range-7d', keys: ['2'], display: '2', label: 'Last 7 days', group: 'Date range' },
	{ id: 'range-30d', keys: ['3'], display: '3', label: 'Last 30 days', group: 'Date range' },
	{ id: 'range-90d', keys: ['4'], display: '4', label: 'Last 90 days', group: 'Date range' },
	{
		id: 'clear-segment',
		keys: ['x', 'X'],
		display: 'X',
		label: 'Clear the active segment filter',
		group: 'Filtering & display',
	},
	{
		id: 'toggle-clock',
		keys: ['t', 'T'],
		display: 'T',
		label: 'Switch all times between your timezone and UTC',
		group: 'Filtering & display',
	},
	{
		id: 'help',
		keys: ['?'],
		display: '?',
		label: 'Show or hide this list',
		group: 'Help',
	},
];

/** Roles that behave as a text field even on a non-input element. */
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/**
 * True when the element owns the keystrokes it receives. Deliberately generous: a false positive
 * costs one shortcut that did not fire, a false negative eats a character out of somebody's
 * sentence — and the second is the one that makes a keyboard layer feel hostile.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!target || !(target as Partial<Element>).tagName) return false;
	const element = target as HTMLElement;
	const tag = element.tagName.toLowerCase();
	if (tag === 'textarea' || tag === 'select') return true;
	if (tag === 'input') {
		// Only text-entry inputs swallow keys; a checkbox or a radio does not type.
		const type = (element as HTMLInputElement).type;
		return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
	}
	if (element.isContentEditable) return true;
	const role = element.getAttribute?.('role');
	return role != null && TEXT_ROLES.has(role);
}

/**
 * The shortcut this event fires, or null. Every safety rule lives here so no caller can forget one —
 * a handler is `const id = matchShortcut(event); if (!id) return;` and nothing else.
 */
export function matchShortcut(event: KeyboardEvent): ShortcutId | null {
	if (event.defaultPrevented || event.repeat || event.isComposing) return null;
	if (event.ctrlKey || event.metaKey || event.altKey) return null;
	// The focused element wins over the page in every case; `event.target` catches shadow/portal
	// content whose activeElement is the host.
	if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return null;
	return SHORTCUTS.find((shortcut) => shortcut.keys.includes(event.key))?.id ?? null;
}
