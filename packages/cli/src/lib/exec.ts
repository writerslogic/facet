// The single choke point for every shell-out the installer makes. WHY it exists: `facet init` drives
// wrangler and pnpm, and a test must be able to assert the exact argv — and that a secret never lands
// in one — without executing anything. Everything takes a `Runner`, so tests inject a fake.

import { spawn } from 'node:child_process';

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	cwd?: string;
	/**
	 * Written to the child's stdin, which is then closed. This is the ONLY channel a secret may
	 * travel on: argv is visible to every process on the machine via `ps`, stdin is not.
	 */
	stdin?: string;
	/** Mirror the child's output to this process while still capturing it (long-running steps). */
	stream?: boolean;
}

export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

/** Synthesised exit code when the binary itself could not be spawned (ENOENT, EACCES, …). */
export const EXIT_SPAWN_FAILED = 127;

/** Real runner: spawns without a shell, so argv is passed verbatim and nothing is word-split. */
export const spawnRunner: Runner = (command, args, options = {}) =>
	new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
			if (options.stream) process.stdout.write(chunk);
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
			if (options.stream) process.stderr.write(chunk);
		});
		child.on('error', (err) => {
			resolve({ code: EXIT_SPAWN_FAILED, stdout, stderr: err.message });
		});
		child.on('close', (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
		// Always close stdin: wrangler treats a non-TTY stdin as non-interactive and skips its
		// confirmation prompts, which is what we want — every destructive step is confirmed by us first.
		child.stdin.end(options.stdin ?? '');
	});
