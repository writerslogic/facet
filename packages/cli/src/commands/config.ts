// `facet config`: D1 bootstrap helpers over a wrangler.jsonc.
//   set-db-id  — write the D1 `database_id` via a targeted string replace that PRESERVES comments
//                and unrelated config (no JSON reparse/rewrite). Refuses to overwrite a real id.
//   check      — exit nonzero if `database_id` is missing or still the placeholder.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { printError } from '../util.js';

const PLACEHOLDER = 'PLACEHOLDER_D1_DATABASE_ID';
const DEFAULT_CONFIGS = ['./wrangler.jsonc', 'apps/server/wrangler.jsonc'];
const DB_ID_RE = /("database_id"\s*:\s*")([^"]*)(")/;

/** Resolve the config path: an explicit --config, else the first existing default. */
function resolveConfigPath(flag: string | undefined): string | null {
	if (flag) return existsSync(flag) ? flag : null;
	for (const candidate of DEFAULT_CONFIGS) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
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
	if (!path) {
		printError(
			values.config
				? `Config not found: ${values.config}`
				: `No wrangler.jsonc found (looked in ${DEFAULT_CONFIGS.join(', ')}). Pass --config <path>.`,
		);
		return 1;
	}

	const source = readFileSync(path, 'utf8');
	const match = source.match(DB_ID_RE);
	if (!match) {
		printError(`No "database_id" field found in ${path}.`);
		return 1;
	}

	const current = match[2];
	if (current && current !== PLACEHOLDER && current !== values.id && !values.force) {
		printError(
			`Refusing to overwrite existing database_id "${current}" in ${path}. Pass --force to override.`,
		);
		return 1;
	}

	// Targeted replace of only the value between the quotes; the surrounding text (comments, other
	// fields, formatting) is left byte-for-byte intact.
	const updated = source.replace(DB_ID_RE, `$1${values.id}$3`);
	writeFileSync(path, updated);
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
	if (!path) {
		printError(
			values.config
				? `Config not found: ${values.config}`
				: `No wrangler.jsonc found (looked in ${DEFAULT_CONFIGS.join(', ')}). Pass --config <path>.`,
		);
		return 1;
	}

	const source = readFileSync(path, 'utf8');
	const match = source.match(DB_ID_RE);
	if (!match || !match[2]) {
		printError(`database_id is missing or empty in ${path}.`);
		return 1;
	}
	if (match[2] === PLACEHOLDER) {
		printError(
			`database_id in ${path} is still the placeholder. Run \`facet config set-db-id --id <id>\` first.`,
		);
		return 1;
	}
	process.stdout.write(`database_id in ${path} is set.\n`);
	return 0;
}
