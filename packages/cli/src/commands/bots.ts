// `facet bots status|refresh`: inspect and refresh the operator-refreshable crawler ruleset. Both
// hit admin-only endpoints; the admin token only ever travels in the Authorization header.

import { parseArgs } from 'node:util';
import pc from 'picocolors';
import {
	type AdminClient,
	type FetchJson,
	UsageError,
	adminClient,
	renderTable,
	resolveAdminToken,
	resolveHost,
} from '../admin.js';
import { fetchJson, printError } from '../util.js';

const COMMON = {
	host: { type: 'string' },
	'admin-token': { type: 'string' },
	json: { type: 'boolean' },
} as const;

interface RulesetStatus {
	rulesets: {
		source: string;
		pattern_count: number;
		updated_at: number;
		etag: string | null;
	}[];
	active_patterns: number;
}

function client(
	values: Record<string, string | boolean | undefined>,
	fetchImpl: FetchJson,
): AdminClient {
	const host = resolveHost(values.host as string | undefined);
	const token = resolveAdminToken(values['admin-token'] as string | undefined);
	return adminClient(host, token, fetchImpl);
}

const MAX_CELL = 80;

// IMPORTANT: `etag` is copied verbatim from whatever FACET_BOT_RULESET_URL returned, and every cell
// comes from the host the operator pointed `--host` at. Rendering one raw would let a remote response
// drive the operator's terminal or pad the table to its own width.
function cell(value: unknown): string {
	const out: string[] = [];
	for (const ch of typeof value === 'string' ? value : String(value ?? '')) {
		const code = ch.codePointAt(0) ?? 0;
		out.push(code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : ch);
		if (out.length >= MAX_CELL) return `${out.slice(0, MAX_CELL - 1).join('')}…`;
	}
	return out.join('');
}

function fmtTime(ms: unknown): string {
	const at = new Date(typeof ms === 'number' ? ms : Number.NaN);
	return Number.isNaN(at.getTime()) ? '-' : at.toISOString();
}

function print(status: RulesetStatus, asJson: boolean): number {
	if (asJson) {
		process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
		return 0;
	}
	if (!Array.isArray(status?.rulesets)) {
		throw new UsageError(
			'Unexpected response from the bots endpoint: no ruleset list. Is --host a Facet deployment?',
		);
	}
	if (status.rulesets.length === 0) {
		process.stdout.write(`${pc.dim('No bot ruleset stored yet. Run `facet bots refresh`.')}\n`);
		return 0;
	}
	process.stdout.write(
		renderTable(
			['SOURCE', 'PATTERNS', 'UPDATED', 'ETAG'],
			status.rulesets.map((r) => [
				cell(r?.source),
				cell(r?.pattern_count),
				fmtTime(r?.updated_at),
				r?.etag == null ? '-' : cell(r.etag),
			]),
		),
	);
	process.stdout.write(
		`${pc.dim(`Active in the serving isolate: ${cell(status.active_patterns)}`)}\n`,
	);
	return 0;
}

export async function runBots(args: string[], fetchImpl: FetchJson = fetchJson): Promise<number> {
	const [sub, ...rest] = args;
	if (sub !== 'status' && sub !== 'refresh') {
		printError(
			'Usage: facet bots <status|refresh> [--host <url>] [--admin-token <t>] [--json]',
		);
		return 1;
	}
	const { values } = parseArgs({ args: rest, options: { ...COMMON }, allowPositionals: false });
	try {
		const api = client(values, fetchImpl);
		const status =
			sub === 'status'
				? await api.get<RulesetStatus>('/api/bots/ruleset')
				: await api.post<RulesetStatus>('/api/bots/refresh', {});
		return print(status, values.json === true);
	} catch (err) {
		if (err instanceof UsageError) {
			printError(err.message);
			return 1;
		}
		const detail = err instanceof Error ? err.message : String(err);
		// `fetchJson` appends `: <message>` when the error envelope carries one, so match the code.
		const code = detail.split(': ')[0] ?? detail;
		if (code === 'bot_ruleset_unconfigured') {
			printError(
				'Bot ruleset refresh is not configured: set the FACET_BOT_RULESET_URL var on the Worker (https only).',
			);
			return 1;
		}
		if (code === 'bot_ruleset_misconfigured') {
			printError(
				'FACET_BOT_RULESET_URL is set but unusable: it must be an absolute https URL.',
			);
			return 1;
		}
		if (code === 'bot_ruleset_refresh_failed') {
			printError(
				'Bot ruleset refresh failed upstream: FACET_BOT_RULESET_URL was unreachable, redirected off https, or returned a payload that failed validation. The Worker withholds the upstream detail on purpose; the stored ruleset is unchanged.',
			);
			return 1;
		}
		printError(`bots ${sub} failed: ${detail}`);
		return 1;
	}
}
