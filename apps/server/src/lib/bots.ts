// Bot filtering: user-agent heuristics + a known-bot substring list. Used by /api/collect
// to drop non-human traffic before writing events. Real list/logic lands in T009.

/** Returns true if the user-agent looks like a bot/crawler and should be dropped. */
export function isBot(_userAgent: string): boolean {
	return false;
}
