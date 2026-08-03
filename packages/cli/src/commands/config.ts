// `facet config`: D1 bootstrap helpers over a wrangler.jsonc. The edits themselves live in
// lib/wranglerConfig.ts — a targeted string replace (no JSON reparse) so comments and unrelated
// config survive byte-for-byte — and are shared with `facet init`, which drives the same writes.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
	PLACEHOLDER_DB_ID,
	getDatabaseId,
	hasDatabaseIdField,
	setDatabaseId,
} from '../lib/wranglerConfig.js';
import { printError } from '../util.js';

const DEFAULT_CONFIGS = ['./wrangler.jsonc', 'apps/server/wrangler.jsonc'];

/** Resolve the config path: an explicit --config, else the first existing default. */
function resolveConfigPath(flag: string | undefined): string | null {
	if (flag) return existsSync(flag) ? flag : null;
	for (const candidate of DEFAULT_CONFIGS) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function reportMissingConfig(flag: string | undefined): number {
	printError(
		flag
			? `Config not found: ${flag}`
			: `No wrangler.jsonc found (looked in ${DEFAULT_CONFIGS.join(', ')}). Pass --config <path>.`,
	);
	return 1;
}

export function runConfig(args: string[]): number {
	const [sub, ...rest] = args;
	if (sub === 'set-db-id') return setDbId(rest);
	if (sub === 'check') return check(rest);
	printError('Usage: facet config <set-db-id|check> [options]');
	return 1;
}

function setDbId(args: string[]): number {
	const { values } = parseArgs({
		args,
		options: {
			id: { type: 'string' },
			config: { type: 'string' },
			force: { type: 'boolean' },
		},
		allowPositionals: false,
	});

	if (!values.id) {
		printError('Missing required option: --id <database_id>.');
		return 1;
	}
	const path = resolveConfigPath(values.config);
	if (!path) return reportMissingConfig(values.config);

	const source = readFileSync(path, 'utf8');
	if (!hasDatabaseIdField(source)) {
		printError(`No "database_id" field found in ${path}.`);
		return 1;
	}

	const edit = setDatabaseId(source, values.id, Boolean(values.force));
	if (!edit.ok) {
		printError(`${edit.reason.replace(/\.$/, '')} in ${path}.`);
		return 1;
	}
	writeFileSync(path, edit.source);
	process.stdout.write(`Set database_id in ${path}.\n`);
	return 0;
}

function check(args: string[]): number {
	const { values } = parseArgs({
		args,
		options: { config: { type: 'string' } },
		allowPositionals: false,
	});

	const path = resolveConfigPath(values.config);
	if (!path) return reportMissingConfig(values.config);

	const source = readFileSync(path, 'utf8');
	if (!hasDatabaseIdField(source)) {
		printError(`database_id is missing or empty in ${path}.`);
		return 1;
	}
	if (getDatabaseId(source) === null) {
		const empty = !source.includes(PLACEHOLDER_DB_ID);
		printError(
			empty
				? `database_id is missing or empty in ${path}.`
				: `database_id in ${path} is still the placeholder. Run \`facet init\` (or \`facet config set-db-id --id <id>\`) first.`,
		);
		return 1;
	}
	process.stdout.write(`database_id in ${path} is set.\n`);
	return 0;
}
