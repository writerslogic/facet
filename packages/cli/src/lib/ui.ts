// Output helpers for the installer. Kept separate from the logic so every write goes through an
// injectable sink (tests capture it and assert no secret ever reaches stdout).

import pc from 'picocolors';

export type Write = (chunk: string) => void;

function isControl(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	return (code < 0x20 && ch !== '\n' && ch !== '\t') || (code >= 0x7f && code <= 0x9f);
}

// REQUIRED: wrangler's stdout/stderr and Cloudflare API strings reach these helpers verbatim (see
// `detail` in lib/cf.ts), so an escape sequence in one could repaint or erase the installer's log.
export function stripControl(text: string): string {
	let clean = '';
	for (const ch of text) if (!isControl(ch)) clean += ch;
	return clean;
}

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
		heading: (text) => out(`\n${pc.bold(stripControl(text))}\n`),
		step: (index, total, title) =>
			out(`\n${pc.dim(`[${index}/${total}]`)} ${pc.bold(stripControl(title))}\n`),
		ok: (text) => out(`  ${pc.green('✓')} ${stripControl(text)}\n`),
		skip: (text) => out(`  ${pc.dim('•')} ${stripControl(text)}\n`),
		info: (text) => out(`  ${pc.dim(stripControl(text))}\n`),
		warn: (text) => out(`  ${pc.yellow('!')} ${stripControl(text)}\n`),
		fail: (text) => err(`${pc.red('✗')} ${stripControl(text)}\n`),
		blank: () => out('\n'),
	};
}
