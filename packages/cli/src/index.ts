// countless-cli entrypoint: dispatches `init`, `migrate`, and `stats` subcommands.

import { runInit } from './commands/init.js';
import { runMigrate } from './commands/migrate.js';
import { runStats } from './commands/stats.js';

const USAGE = 'Usage: countless <init|migrate|stats> [options]\n';

export async function main(argv: string[]): Promise<number> {
	const [command] = argv;
	switch (command) {
		case 'init':
			return runInit(argv.slice(1));
		case 'migrate':
			return runMigrate(argv.slice(1));
		case 'stats':
			return runStats(argv.slice(1));
		case '--help':
		case '-h':
			process.stdout.write(USAGE);
			return 0;
		case undefined:
			process.stdout.write(USAGE);
			return 0;
		default:
			process.stderr.write(USAGE);
			return 1;
	}
}

const isMain =
	typeof process.argv[1] === 'string' &&
	import.meta.url === new URL(process.argv[1], 'file://').href;

if (isMain) {
	void main(process.argv.slice(2)).then((code) => process.exit(code));
}
