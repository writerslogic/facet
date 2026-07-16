// Executes a constrained QueryIntent over the existing aggregate stats helpers. The intent is a
// validated structured object (never model-authored SQL): a dimension triggers a top-N breakdown,
// otherwise a scalar metric. Breakdowns count pageview/event rows (or sessions for `channel`), which
// approximate — not precisely reproduce — the chosen metric; this is acceptable for v1.

import type { CountRow, NlQueryResult, QueryIntent, StatsFilter } from '@countless/shared';
import type { Env } from '../env.js';
import {
	channels,
	engagement,
	summary,
	topCountries,
	topDevices,
	topPaths,
	topReferrers,
} from './stats.js';

const percentFormat = new Intl.NumberFormat('en-US', {
	style: 'percent',
	maximumFractionDigits: 1,
});

async function breakdownRows(
	env: Env,
	f: StatsFilter,
	dimension: NonNullable<QueryIntent['dimension']>,
	limit: number,
): Promise<CountRow[]> {
	switch (dimension) {
		case 'path':
			return topPaths(env, f, limit);
		case 'referrer':
			return topReferrers(env, f, limit);
		case 'country':
			return topCountries(env, f, limit);
		case 'device':
			return (await topDevices(env, f)).slice(0, limit);
		case 'channel':
			return (await channels(env, f)).slice(0, limit);
	}
}

async function scalarValue(
	env: Env,
	f: StatsFilter,
	metric: QueryIntent['metric'],
): Promise<number> {
	if (metric === 'sessions' || metric === 'bounce_rate') {
		const e = await engagement(env, f);
		return metric === 'sessions' ? e.sessions : e.bounce_rate;
	}
	const s = await summary(env, f);
	return s[metric];
}

export async function runQueryIntent(
	env: Env,
	siteId: string,
	intent: QueryIntent,
	f: StatsFilter,
): Promise<NlQueryResult> {
	// Force the executed filter to the caller's site — the query is always scoped to `siteId`.
	const scoped: StatsFilter = { ...f, siteId };
	if (intent.dimension) {
		const limit = intent.limit ?? 10;
		const rows = await breakdownRows(env, scoped, intent.dimension, limit);
		const top = rows
			.slice(0, 3)
			.map((r) => `${r.key} (${r.count})`)
			.join(', ');
		const answer = `Top ${intent.dimension} by ${intent.metric}: ${top || 'no data'}`;
		return { intent, answer, result: { kind: 'breakdown', rows } };
	}
	const value = await scalarValue(env, scoped, intent.metric);
	const shown = intent.metric === 'bounce_rate' ? percentFormat.format(value) : String(value);
	return {
		intent,
		answer: `${intent.metric}: ${shown}`,
		result: { kind: 'scalar', value },
	};
}
