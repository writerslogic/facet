// Recent Ask questions, stored locally (question text + timestamp only — never an answer, a number or
// a credential: the whole point of the panel is that data stays server-side).
// Bounded, newest-first, de-duplicated.

const STORAGE = 'facet.askHistory';
const CAP = 10;

export interface AskEntry {
	question: string;
	at: number;
}

/**
 * Dedupe key for a question. Case and whitespace are noise here — "Top pages", "top pages" and
 * "top  pages" are one question to a reader, and keeping three of them burns the 10-entry cap on
 * near-duplicates instead of on genuinely different questions.
 */
function dedupeKey(question: string): string {
	return question.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function readAskHistory(): AskEntry[] {
	try {
		const raw = localStorage.getItem(STORAGE);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(e): e is AskEntry =>
				typeof e === 'object' &&
				e !== null &&
				typeof (e as AskEntry).question === 'string' &&
				(e as AskEntry).question.trim().length > 0 &&
				typeof (e as AskEntry).at === 'number' &&
				Number.isFinite((e as AskEntry).at),
		);
	} catch {
		return [];
	}
}

/** Prepend a question (de-duped case/whitespace-insensitively, capped). Returns the new list. */
export function pushAskHistory(question: string, now: number = Date.now()): AskEntry[] {
	const trimmed = question.trim();
	if (!trimmed) return readAskHistory();
	const key = dedupeKey(trimmed);
	// Re-asking keeps the newest spelling and moves the entry to the front, so the list stays ordered
	// by "when you last cared about this", not by first sighting.
	const existing = readAskHistory().filter((e) => dedupeKey(e.question) !== key);
	const next = [{ question: trimmed, at: now }, ...existing].slice(0, CAP);
	try {
		localStorage.setItem(STORAGE, JSON.stringify(next));
	} catch {
		// storage unavailable: history is best-effort.
	}
	return next;
}

/** Drop one question from the history (by its dedupe key). Returns the new list. */
export function removeAskHistory(question: string): AskEntry[] {
	const key = dedupeKey(question);
	const next = readAskHistory().filter((e) => dedupeKey(e.question) !== key);
	try {
		localStorage.setItem(STORAGE, JSON.stringify(next));
	} catch {
		// storage unavailable: history is best-effort.
	}
	return next;
}

export function clearAskHistory(): AskEntry[] {
	try {
		localStorage.removeItem(STORAGE);
	} catch {
		// ignore
	}
	return [];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Coarse "when did I ask this" label for a history chip. Deliberately coarse: the exact second is
 * noise, and the only question a reader has is whether an entry is from this session or last week.
 */
export function formatAskAge(at: number, now: number = Date.now()): string {
	const delta = now - at;
	if (!Number.isFinite(delta) || delta < MINUTE) return 'just now';
	if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
	if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
	return `${Math.floor(delta / DAY)}d ago`;
}

export { CAP as ASK_HISTORY_CAP };
