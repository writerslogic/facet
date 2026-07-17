// Recent Ask questions, stored locally (question text + timestamp only — never credentials).
// Bounded, newest-first, de-duplicated.

const STORAGE = 'facet.askHistory';
const CAP = 10;

export interface AskEntry {
	question: string;
	at: number;
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
				typeof (e as AskEntry).at === 'number',
		);
	} catch {
		return [];
	}
}

/** Prepend a question (de-duped, capped). Returns the new list. */
export function pushAskHistory(question: string, now: number = Date.now()): AskEntry[] {
	const trimmed = question.trim();
	if (!trimmed) return readAskHistory();
	const existing = readAskHistory().filter((e) => e.question !== trimmed);
	const next = [{ question: trimmed, at: now }, ...existing].slice(0, CAP);
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

export { CAP as ASK_HISTORY_CAP };
