// Hand-rolled prompts over node:readline/promises. Deliberately tiny and dependency-free, and
// injectable so the installer's interactive branches are testable without a TTY.
//
// Every prompt carries a default that Enter accepts. When stdin is not a TTY (CI, a pipe) or the user
// passed --yes, `autoPrompter` takes the default and announces the choice instead of hanging forever.

import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';

export interface Prompter {
	/** Free-text question. Empty input (Enter) yields `fallback`. */
	text(message: string, fallback: string): Promise<string>;
	/** Yes/no question. Enter yields `fallback`. */
	confirm(message: string, fallback: boolean): Promise<boolean>;
	/** Release the underlying readline handle, if any. */
	close(): void;
}

/** Interactive prompter bound to the real stdin/stdout. */
export function ttyPrompter(): Prompter {
	let rl: ReturnType<typeof createInterface> | null = null;
	const io = () => {
		if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
		return rl;
	};
	return {
		async text(message, fallback) {
			const suffix = fallback ? pc.dim(` (${fallback})`) : pc.dim(' (empty)');
			const answer = await io().question(`${pc.cyan('?')} ${message}${suffix}: `);
			return answer.trim() === '' ? fallback : answer.trim();
		},
		async confirm(message, fallback) {
			const hint = fallback ? 'Y/n' : 'y/N';
			const answer = (
				await io().question(`${pc.cyan('?')} ${message} ${pc.dim(`[${hint}]`)} `)
			)
				.trim()
				.toLowerCase();
			if (answer === '') return fallback;
			return answer === 'y' || answer === 'yes';
		},
		close() {
			rl?.close();
			rl = null;
		},
	};
}

/** Non-interactive prompter: takes every default and prints what it chose, so the log is auditable. */
export function autoPrompter(write: (line: string) => void): Prompter {
	return {
		async text(message, fallback) {
			write(`${pc.dim('?')} ${message}: ${fallback || '(empty)'} ${pc.dim('[default]')}\n`);
			return fallback;
		},
		async confirm(message, fallback) {
			write(`${pc.dim('?')} ${message}: ${fallback ? 'yes' : 'no'} ${pc.dim('[default]')}\n`);
			return fallback;
		},
		close() {},
	};
}
