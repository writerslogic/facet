// `facet stats`: fetch summary stats with an API key and print a compact table. Fetcher is injectable.

import { parseArgs } from 'node:util';
import type { StatsResponse } from '@facet/shared';
import pc from 'picocolors';
import { fetchJson, printError } from '../util.js';

type FetchJson = <T>(url: string, init?: RequestInit) => Promise<T>;

const RANGE_DAYS: Record<string, number> = {
	'24h': 1,
	'7d': 7,
	'30d': 30,
	'90d': 90,
};
const DAY_MS = 86_400_000;

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

	const host = values.host;
	const key = values.key;
	const site = values.site;
	if (!host || !key || !site) {
		printError('Missing required option: --host, --key, and --site are all required.');
		return 1;
	}

	const range = values.range ?? '7d';
	const days = RANGE_DAYS[range] ?? 7;
	const end = Date.now();
	const start = end - days * DAY_MS;
	const url = `${host.replace(/\/$/, '')}/api/stats?site_id=${site}&start=${start}&end=${end}`;

	try {
		const data = await fetchImpl<StatsResponse>(url, {
			headers: { Authorization: `Bearer ${key}` },
		});
		const { pageviews, visitors, events } = data.summary;
		process.stdout.write(`${pc.bold('Facet stats')} (${range})\n`);
		process.stdout.write(`  Pageviews: ${pageviews}\n`);
		process.stdout.write(`  Visitors:  ${visitors}\n`);
		process.stdout.write(`  Events:    ${events}\n`);
		if (data.top_paths.length > 0) {
			process.stdout.write(`\n${pc.bold('Top paths')}\n`);
			for (const row of data.top_paths.slice(0, 5)) {
				process.stdout.write(`  ${row.count}\t${row.key}\n`);
			}
		}
		return 0;
	} catch (err) {
		printError(`stats request failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}
