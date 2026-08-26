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

function print(status: RulesetStatus, asJson: boolean): number {
	if (asJson) {
		process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
		return 0;
	}
	if (status.rulesets.length === 0) {
		process.stdout.write(`${pc.dim('No bot ruleset stored yet. Run `facet bots refresh`.')}\n`);
		return 0;
	}
	process.stdout.write(
		renderTable(
			['SOURCE', 'PATTERNS', 'UPDATED', 'ETAG'],
			status.rulesets.map((r) => [
				r.source,
				String(r.pattern_count),
				new Date(r.updated_at).toISOString(),
				r.etag ?? '-',
			]),
		),
	);
	process.stdout.write(`${pc.dim(`Active in the serving isolate: ${status.active_patterns}`)}\n`);
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
		const code = err instanceof Error ? err.message : String(err);
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
		printError(`bots ${sub} failed: ${code}`);
		return 1;
	}
}
