#!/usr/bin/env node
// countless-cli entrypoint: dispatches `init`, `migrate`, and `stats` subcommands.
// Argument parsing is intentionally dependency-free. Real dispatch lands in T027.

import { runInit } from './commands/init.js';
import { runMigrate } from './commands/migrate.js';
import { runStats } from './commands/stats.js';

async function main(argv: string[]): Promise<number> {
	const [command] = argv;
	switch (command) {
		case 'init':
			return runInit(argv.slice(1));
		case 'migrate':
			return runMigrate(argv.slice(1));
		case 'stats':
			return runStats(argv.slice(1));
		default:
			process.stdout.write('Usage: countless <init|migrate|stats> [options]\n');
			return command ? 1 : 0;
	}
}

main(process.argv.slice(2)).then((code) => {
	process.exit(code);
});
