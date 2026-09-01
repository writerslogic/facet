// `facet stats`: fetch summary stats with an API key and print a compact table. Fetcher is injectable.

import { parseArgs } from 'node:util';
import type { StatsResponse } from '@facet/shared';
import pc from 'picocolors';
import { resolveHost } from '../admin.js';
import { fetchJson, printError } from '../util.js';

type FetchJson = <T>(url: string, init?: RequestInit) => Promise<T>;

const RANGE_DAYS: Record<string, number> = {
	'24h': 1,
	'7d': 7,
	'30d': 30,
	'90d': 90,
};
const DAY_MS = 86_400_000;

/** IMPORTANT: a `top_paths` key is visitor-supplied — `/api/collect` requires only a leading `/` under
 * 2048 chars — so it reaches this terminal with ESC, CR and bidi runs intact and can otherwise rewrite
 * the rows already printed above it. */
const CONTROL_RE = /[\p{Cc}\p{Cf}]/gu;

function safeCell(value: string, limit = 120): string {
	const flat = String(value).replace(CONTROL_RE, '');
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export async function runStats(args: string[], fetchImpl: FetchJson = fetchJson): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			host: { type: 'string' },
			key: { type: 'string' },
			site: { type: 'string' },
			range: { type: 'string' },
		},
		allowPositionals: false,
	});

	const key = values.key;
	const site = values.site;
	if (!key || !site) {
		printError('Missing required option: --key and --site are both required.');
		return 1;
	}
	// IMPORTANT: undici echoes the whole rejected header value into its error message, and this
	// command prints a failed request's message to stderr — so a key carrying a stray newline from a
	// wrapped paste would put the live credential in the terminal and in any pasted log.
	if (!/^[!-~]+$/.test(key)) {
		printError('--key contains characters that are not valid in an Authorization header.');
		return 1;
	}

	// Same host resolution as every other remote command (flag, else FACET_HOST): `stats` read the
	// flag directly, so the env var every other command honors silently did nothing here.
	let origin: string;
	try {
		origin = resolveHost(values.host);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		return 1;
	}

	const range = values.range ?? '7d';
	const days = RANGE_DAYS[range];
	if (days === undefined) {
		printError(`--range must be one of: ${Object.keys(RANGE_DAYS).join(', ')} (got: ${range})`);
		return 1;
	}
	const end = Date.now();
	const start = end - days * DAY_MS;
	const query = new URLSearchParams({
		site_id: site,
		start: String(start),
		end: String(end),
	});
	const url = `${origin}/api/stats?${query}`;

	try {
		const data = await fetchImpl<StatsResponse>(url, {
			headers: { Authorization: `Bearer ${key}` },
		});
		const summary: unknown = data.summary;
		if (summary === null || typeof summary !== 'object') {
			printError('stats request failed: the response carried no summary.');
			return 1;
		}
		const { pageviews, visitors, events } = data.summary;
		process.stdout.write(`${pc.bold('Facet stats')} (${range})\n`);
		process.stdout.write(`  Pageviews: ${pageviews}\n`);
		process.stdout.write(`  Visitors:  ${visitors}\n`);
		process.stdout.write(`  Events:    ${events}\n`);
		const paths = Array.isArray(data.top_paths) ? data.top_paths.slice(0, 5) : [];
		if (paths.length > 0) {
			process.stdout.write(`\n${pc.bold('Top paths')}\n`);
			for (const row of paths) {
				process.stdout.write(`  ${row.count}\t${safeCell(row.key)}\n`);
			}
		}
		return 0;
	} catch (err) {
		printError(`stats request failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}
