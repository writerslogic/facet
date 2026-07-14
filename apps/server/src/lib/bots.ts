// Bot filtering: the `isbot` list is the sole bot-list source for v1. Used by /api/collect to
// drop non-human traffic before writing events. Empty/whitespace user-agents count as bots.

import { isbot } from 'isbot';

/** Returns true if the user-agent looks like a bot/crawler and should be dropped. */
export function isBot(userAgent: string): boolean {
	if (!userAgent.trim()) {
		return true;
	}
	return isbot(userAgent);
}
