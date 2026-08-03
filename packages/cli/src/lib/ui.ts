// Output helpers for the installer. Kept separate from the logic so every write goes through an
// injectable sink (tests capture it and assert no secret ever reaches stdout).

import pc from 'picocolors';

export type Write = (chunk: string) => void;

export interface Ui {
	out: Write;
	err: Write;
	heading(text: string): void;
	step(index: number, total: number, title: string): void;
	ok(text: string): void;
	skip(text: string): void;
	info(text: string): void;
	warn(text: string): void;
	fail(text: string): void;
	blank(): void;
}

export function createUi(out: Write, err: Write): Ui {
	return {
		out,
		err,
		heading: (text) => out(`\n${pc.bold(text)}\n`),
		step: (index, total, title) =>
			out(`\n${pc.dim(`[${index}/${total}]`)} ${pc.bold(title)}\n`),
		ok: (text) => out(`  ${pc.green('✓')} ${text}\n`),
		skip: (text) => out(`  ${pc.dim('•')} ${text}\n`),
		info: (text) => out(`  ${pc.dim(text)}\n`),
		warn: (text) => out(`  ${pc.yellow('!')} ${text}\n`),
		fail: (text) => err(`${pc.red('✗')} ${text}\n`),
		blank: () => out('\n'),
	};
}
