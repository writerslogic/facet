// Targeted, comment-preserving reads and edits of a wrangler.jsonc.
//
// WHY string surgery instead of parse → mutate → stringify: the shipped config is heavily commented
// (every binding explains itself, and the post-v1 scale path lives in comments). A JSON round-trip
// would delete all of it. Every edit here is line-scoped and leaves untouched bytes untouched.

export const PLACEHOLDER_DB_ID = 'PLACEHOLDER_D1_DATABASE_ID';

/** The route the upstream repo ships. A fresh clone deploying this would target a zone it does not own. */
export const UPSTREAM_ROUTE = 'facet.writerslogic.com';

const DB_ID_RE = /("database_id"\s*:\s*")([^"]*)(")/;
const DB_NAME_RE = /"database_name"\s*:\s*"([^"]*)"/;
const WORKER_NAME_RE = /"name"\s*:\s*"([^"]*)"/;
const QUEUE_NAME_RE = /"queue"\s*:\s*"([^"]*)"/;
const DLQ_RE = /"dead_letter_queue"\s*:\s*"([^"]*)"/;
const ROUTE_PATTERN_RE = /"pattern"\s*:\s*"([^"]*)"/;

export type EditResult = { ok: true; source: string } | { ok: false; reason: string };

/** Index of the first uncommented line whose first token is `"<key>"`, or -1. */
function findKeyLine(lines: string[], key: string): number {
	const needle = `"${key}"`;
	return lines.findIndex((line) => {
		const trimmed = line.trimStart();
		return !trimmed.startsWith('//') && trimmed.startsWith(needle);
	});
}

function indentOf(line: string): string {
	return line.slice(0, line.length - line.trimStart().length);
}

// REQUIRED: every setter writes its value inside a JSONC string literal, so a quote, a backslash or a
// control character escapes that literal and injects arbitrary deployment config (a second route, a
// `vars` override) into the file the Worker deploys from. Rejected rather than escaped: no legal D1
// name, queue name or route pattern contains one. The reason never echoes the value back to a terminal.
function unsafeReason(field: string, value: string): string | null {
	if (value === '') return `Empty ${field}.`;
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === '"' || ch === '\\' || code < 0x20 || code === 0x7f)
			return `Invalid ${field}: quotes, backslashes and control characters are not allowed.`;
	}
	return null;
}

/** The configured `database_id`, or null when absent or still the placeholder. */
export function getDatabaseId(source: string): string | null {
	const match = source.match(DB_ID_RE);
	if (!match?.[2] || match[2] === PLACEHOLDER_DB_ID) return null;
	return match[2];
}

/** True when the file has a `database_id` field at all (set, empty, or placeholder). */
export function hasDatabaseIdField(source: string): boolean {
	return DB_ID_RE.test(source);
}

export function getDatabaseName(source: string): string | null {
	return source.match(DB_NAME_RE)?.[1] ?? null;
}

/**
 * Rename the bound database. Needed when the operator points the install at a different D1 database
 * with --db: `wrangler d1 migrations apply <name>` resolves that name through this config, so an id
 * without a matching name fails at the migration step.
 */
export function setDatabaseName(source: string, name: string): EditResult {
	const unsafe = unsafeReason('database_name', name);
	if (unsafe) return { ok: false, reason: unsafe };
	if (!DB_NAME_RE.test(source)) return { ok: false, reason: 'No "database_name" field found.' };
	return { ok: true, source: source.replace(DB_NAME_RE, () => `"database_name": "${name}"`) };
}

/** The Worker name — the first `"name"` key, which in a wrangler config is the top-level one. */
export function getWorkerName(source: string): string | null {
	return source.match(WORKER_NAME_RE)?.[1] ?? null;
}

export function getQueueName(source: string): string | null {
	return source.match(QUEUE_NAME_RE)?.[1] ?? null;
}

export function getDeadLetterQueueName(source: string): string | null {
	return source.match(DLQ_RE)?.[1] ?? null;
}

/** Add or update the consumer dead-letter queue while preserving the commented JSONC config. */
export function setDeadLetterQueue(source: string, name: string): EditResult {
	const unsafe = unsafeReason('dead_letter_queue', name);
	if (unsafe) return { ok: false, reason: unsafe };
	if (DLQ_RE.test(source)) {
		return { ok: true, source: source.replace(DLQ_RE, () => `"dead_letter_queue": "${name}"`) };
	}
	const lines = source.split('\n');
	const consumer = lines.findIndex(
		(line) => !line.trimStart().startsWith('//') && line.includes('"max_retries"'),
	);
	if (consumer < 0) return { ok: false, reason: 'No queue consumer with "max_retries" found.' };
	const line = lines[consumer];
	if (line === undefined) return { ok: false, reason: 'Queue consumer line disappeared.' };
	const patched = line.replace(
		/"max_retries"\s*:\s*\d+/,
		(retries: string) => `${retries}, "dead_letter_queue": "${name}"`,
	);
	if (patched === line)
		return {
			ok: false,
			reason: 'The queue consumer has no numeric "max_retries" to anchor after.',
		};
	lines[consumer] = patched;
	return { ok: true, source: lines.join('\n') };
}

/**
 * Write `database_id`. Refuses to replace an existing real id unless `force` — a wrong id here points
 * a live deployment at someone else's database, so it is never silently overwritten.
 */
export function setDatabaseId(source: string, id: string, force = false): EditResult {
	const unsafe = unsafeReason('database_id', id);
	if (unsafe) return { ok: false, reason: unsafe };
	const match = source.match(DB_ID_RE);
	if (!match) return { ok: false, reason: 'No "database_id" field found.' };
	const current = match[2];
	if (current && current !== PLACEHOLDER_DB_ID && current !== id && !force) {
		return {
			ok: false,
			reason: `Refusing to overwrite existing database_id "${current}". Pass --force to override.`,
		};
	}
	return {
		ok: true,
		source: source.replace(
			DB_ID_RE,
			(_full: string, open: string, _current: string, close: string) =>
				`${open}${id}${close}`,
		),
	};
}

/** The active custom-domain route pattern, or null when there is none (i.e. workers.dev only). */
export function getRoutePattern(source: string): string | null {
	const lines = source.split('\n');
	const idx = findKeyLine(lines, 'routes');
	if (idx < 0) return null;
	return lines[idx]?.match(ROUTE_PATTERN_RE)?.[1] ?? null;
}

/**
 * Set the custom-domain route to `pattern`, or comment the route out when `pattern` is null (deploy to
 * the free *.workers.dev URL). Only handles a single-line `routes` entry — the shape this repo ships —
 * and reports rather than guesses if someone has hand-expanded it.
 */
export function setRoutePattern(source: string, pattern: string | null): EditResult {
	if (pattern !== null) {
		const unsafe = unsafeReason('route pattern', pattern);
		if (unsafe) return { ok: false, reason: unsafe };
	}
	const lines = source.split('\n');
	const idx = findKeyLine(lines, 'routes');
	const routeLine = (indent: string, value: string) =>
		`${indent}"routes": [{ "pattern": "${value}", "custom_domain": true }],`;

	if (idx < 0) {
		if (pattern === null) return { ok: true, source };
		const nameIdx = findKeyLine(lines, 'name');
		if (nameIdx < 0) return { ok: false, reason: 'No "name" field to anchor the route after.' };
		lines.splice(nameIdx + 1, 0, routeLine(indentOf(lines[nameIdx] ?? ''), pattern));
		return { ok: true, source: lines.join('\n') };
	}

	const current = lines[idx] ?? '';
	if (!/\],?\s*$/.test(current)) {
		return {
			ok: false,
			reason: 'The "routes" entry spans several lines; edit it by hand or collapse it to one line.',
		};
	}
	lines[idx] =
		pattern === null
			? `${indentOf(current)}// ${current.trimStart()}`
			: routeLine(indentOf(current), pattern);
	return { ok: true, source: lines.join('\n') };
}

const CRONS_RE = /"crons"\s*:\s*\[([^\]]*)\]/;

/**
 * Cron expressions declared in the config, or `[]` when the block is absent.
 *
 * IMPORTANT: comment-stripped first, unlike the single-key readers above. The shipped config
 * documents the post-v1 schedule in commented-out `"crons"` lines, and a bare match would report a
 * schedule the deployed Worker does not actually run.
 */
export function getCronTriggers(source: string): string[] {
	const active = source
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('//'))
		.join('\n');
	const body = active.match(CRONS_RE)?.[1];
	if (body === undefined) return [];
	return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '').filter((v) => v !== '');
}

/** True when an active (uncommented) `queues` block is present. */
export function hasQueues(source: string): boolean {
	return findKeyLine(source.split('\n'), 'queues') >= 0;
}

/**
 * Comment out the whole `queues` block. Needed when the account has no Queues entitlement: the Worker
 * falls back to a synchronous D1 write in that case, but a bound-but-nonexistent queue fails the deploy.
 * Depth counting is safe here because no string value inside the block contains a brace.
 */
export function commentOutQueues(source: string): EditResult {
	const lines = source.split('\n');
	const start = findKeyLine(lines, 'queues');
	if (start < 0) return { ok: true, source };
	let depth = 0;
	let end = -1;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (line.trimStart().startsWith('//')) continue;
		for (const ch of line) {
			if (ch === '{' || ch === '[') depth++;
			else if (ch === '}' || ch === ']') depth--;
		}
		if (depth <= 0) {
			end = i;
			break;
		}
	}
	if (end < 0)
		return { ok: false, reason: 'The "queues" block is not balanced; edit it by hand.' };
	for (let i = start; i <= end; i++) {
		const line = lines[i] ?? '';
		lines[i] = `${indentOf(line)}// ${line.trimStart()}`;
	}
	return { ok: true, source: lines.join('\n') };
}
