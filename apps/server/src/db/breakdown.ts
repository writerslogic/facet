// Single-dimension breakdowns, served from the columnar store when this deployment has one and from
// D1 otherwise. Both paths answer the SAME question over the same events; the response says which
// one answered, because only one of them samples.
//
// This is the first read that goes to Analytics Engine. It is a NEW endpoint rather than a swap
// underneath an existing one on purpose: every figure on `/api/stats` is exact today, and quietly
// re-sourcing it would trade that for scale nobody asked for. What this adds is the dimensions D1
// has always stored but no endpoint ever surfaced — city, timezone, the three UTM columns, form
// factor, currency, hostname — with the ordinary filters composed on top.

import type {
	BreakdownDimension,
	BreakdownResponse,
	BreakdownRow,
	StatsFilter,
} from '@facet/shared';
import { desc, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Env } from '../env.js';
import { type FetchLike, aeInt, aeLiteral, aeNumber, queryAe } from '../lib/ae-sql.js';
import { AE_DATASET, type MirroredColumn, VISITOR_BLOB, blobColumn } from '../lib/ae.js';
import { db } from './queries.js';
import * as schema from './schema.js';
import { K_ANON, buildFilteredEventWhere, pageviewCount } from './stats.js';

/** Each groupable dimension's two addresses: the mirrored column it occupies in the columnar store,
 * and the `events` column it occupies in D1. Declared as a total `Record`, so adding a dimension to
 * `BREAKDOWN_DIMENSIONS` without teaching BOTH stores about it is a type error rather than a
 * runtime hole. */
const DIMENSIONS: Record<BreakdownDimension, { blob: MirroredColumn; column: SQLiteColumn }> = {
	hostname: { blob: 'hostname', column: schema.events.hostname },
	path: { blob: 'path', column: schema.events.path },
	referrer: { blob: 'referrer', column: schema.events.referrer },
	event: { blob: 'name', column: schema.events.name },
	country: { blob: 'country', column: schema.events.country },
	region: { blob: 'region', column: schema.events.region },
	city: { blob: 'city', column: schema.events.city },
	timezone: { blob: 'timezone', column: schema.events.timezone },
	network: { blob: 'network', column: schema.events.network },
	language: { blob: 'language', column: schema.events.language },
	device: { blob: 'device', column: schema.events.device },
	form_factor: { blob: 'formFactor', column: schema.events.formFactor },
	browser: { blob: 'browser', column: schema.events.browser },
	os: { blob: 'os', column: schema.events.os },
	channel: { blob: 'channel', column: schema.events.channel },
	utm_source: { blob: 'utmSource', column: schema.events.utmSource },
	utm_medium: { blob: 'utmMedium', column: schema.events.utmMedium },
	utm_campaign: { blob: 'utmCampaign', column: schema.events.utmCampaign },
	currency: { blob: 'currency', column: schema.events.currency },
};

/** The exact-match filters `buildFilteredEventWhere` applies in D1, paired with the mirrored column
 * each one narrows in the columnar store, so the two stores filter on the same values. `hostname` is
 * absent because D1 treats it as truthy-or-absent rather than defined-or-absent — see `aeWhere`. */
const FILTERS = [
	['path', 'path'],
	['referrer', 'referrer'],
	['country', 'country'],
	['device', 'device'],
	['channel', 'channel'],
] as const satisfies readonly (readonly [keyof StatsFilter, MirroredColumn])[];

/** The `WHERE` terms for a filter, or `null` when the columnar store cannot express one of them and
 * must decline the whole read. Dropping the offending term instead would return UNFILTERED rows
 * under a filtered label, which is the failure `/api/stats/distribution` already refuses to ship. */
function aeWhere(f: StatsFilter): string[] | null {
	const site = aeLiteral(f.siteId);
	// Data points carry a second-granular `timestamp`, so a sub-second range boundary is widened to
	// the second enclosing it. Every range this endpoint serves is minute-aligned or coarser.
	const start = aeInt(Math.floor(f.start / 1000));
	const end = aeInt(Math.ceil(f.end / 1000));
	if (site === null || start === null || end === null) {
		return null;
	}
	const terms = [
		`index1 = ${site}`,
		`toUInt32(timestamp) >= ${start}`,
		`toUInt32(timestamp) < ${end}`,
	];
	// Mirrors D1's truthiness test: an empty hostname is no filter at all there, so it is none here.
	if (f.hostname) {
		const literal = aeLiteral(f.hostname);
		if (literal === null) {
			return null;
		}
		terms.push(`${blobColumn('hostname')} = ${literal}`);
	}
	for (const [key, blob] of FILTERS) {
		const value = f[key];
		if (typeof value !== 'string') {
			continue;
		}
		// The one value the two stores disagree on. D1 keeps an absent dimension as NULL (and an
		// absent referrer as ''), while the columnar store has no NULL and keeps both as '' — so
		// `country=''` matches nothing in D1 and every country-less row here. Decline and let D1
		// answer, rather than return a different result set under the same query string.
		const literal = value === '' ? null : aeLiteral(value);
		if (literal === null) {
			return null;
		}
		terms.push(`${blobColumn(blob)} = ${literal}`);
	}
	return terms;
}

/**
 * The breakdown query, or `null` when it cannot be built safely.
 *
 * Every count is weighted by `_sample_interval`: the columnar store samples under load, and a bare
 * `count()` reports the surviving rows rather than the traffic they stand for. `visitors` is the
 * exception that cannot be corrected — a distinct count of sampled rows is a lower bound, no weight
 * recovers the identities that were dropped — which is why the response carries `sampled`.
 */
function aeBreakdownSql(
	f: StatsFilter,
	dimension: BreakdownDimension,
	limit: number,
): string | null {
	const where = aeWhere(f);
	const rows = aeInt(limit);
	if (where === null || rows === null) {
		return null;
	}
	const key = blobColumn(DIMENSIONS[dimension].blob);
	return [
		`SELECT ${key} AS k,`,
		'SUM(_sample_interval) AS total,',
		'SUM(_sample_interval * double3) AS pageviews,',
		`count(DISTINCT ${VISITOR_BLOB}) AS visitors,`,
		'max(_sample_interval) AS sample_interval',
		`FROM ${AE_DATASET}`,
		`WHERE ${where.join(' AND ')}`,
		'GROUP BY k',
		// The same k-anonymity floor D1 applies, on DISTINCT VISITORS rather than events: a group of
		// three pageviews by one person is one person, and this endpoint reaches dimensions (city,
		// campaign) where that distinction is the whole risk. Sampling only tightens it.
		`HAVING visitors >= ${K_ANON}`,
		'ORDER BY total DESC, k ASC',
		`LIMIT ${rows}`,
		'FORMAT JSON',
	].join(' ');
}

interface AeBreakdownRow {
	k?: unknown;
	total?: unknown;
	pageviews?: unknown;
	visitors?: unknown;
	sample_interval?: unknown;
}

/** Read the breakdown from the columnar store, or `null` when this deployment cannot serve it. */
async function aeBreakdown(
	env: Env,
	f: StatsFilter,
	dimension: BreakdownDimension,
	limit: number,
	fetchImpl?: FetchLike,
): Promise<BreakdownResponse | null> {
	const query = aeBreakdownSql(f, dimension, limit);
	if (query === null) {
		return null;
	}
	const data = await queryAe<AeBreakdownRow>(env, query, fetchImpl);
	if (data === null) {
		return null;
	}
	return {
		dimension,
		source: 'analytics_engine',
		sampled: data.some((r) => aeNumber(r.sample_interval) > 1),
		rows: data.map((r) => ({
			key: typeof r.k === 'string' ? r.k : String(r.k ?? ''),
			// Sampling weights are per-row multipliers, so a weighted sum is fractional. Report whole
			// events: a breakdown claiming 41.7 pageviews is an estimate advertised as a measurement.
			events: Math.round(aeNumber(r.total)),
			pageviews: Math.round(aeNumber(r.pageviews)),
			visitors: Math.round(aeNumber(r.visitors)),
		})),
	};
}

/** Read the breakdown from D1 — always exact, and the answer whenever the columnar store declines. */
async function d1Breakdown(
	env: Env,
	f: StatsFilter,
	dimension: BreakdownDimension,
	limit: number,
): Promise<BreakdownRow[]> {
	// Fold NULL to '' so an absent dimension carries the same key it does in the columnar store,
	// which has no NULL. Without this the two sources would label the same group differently.
	const key = sql<string>`COALESCE(${DIMENSIONS[dimension].column}, '')`;
	const total = sql<number>`COUNT(*)`;
	const visitors = sql<number>`COUNT(DISTINCT ${schema.events.visitorHash})`;
	const rows = await db(env)
		.select({ key, total, pageviews: pageviewCount, visitors })
		.from(schema.events)
		.where(buildFilteredEventWhere(f))
		.groupBy(key)
		.having(sql`${visitors} >= ${K_ANON}`)
		.orderBy(desc(total), key)
		.limit(limit);
	return rows.map((r) => ({
		key: String(r.key ?? ''),
		events: Number(r.total ?? 0),
		pageviews: Number(r.pageviews ?? 0),
		visitors: Number(r.visitors ?? 0),
	}));
}

/**
 * Group the range by one dimension. Prefers the columnar store and falls back to D1 for every reason
 * it can decline — unbound, unconfigured, retention-gated, a filter value it cannot express safely,
 * or a query the API rejected. The fallback is not a degraded mode: D1 holds the same events and
 * answers exactly, it just scans to do it.
 */
export async function breakdown(
	env: Env,
	f: StatsFilter,
	dimension: BreakdownDimension,
	limit: number,
	fetchImpl?: FetchLike,
): Promise<BreakdownResponse> {
	const columnar = await aeBreakdown(env, f, dimension, limit, fetchImpl);
	if (columnar !== null) {
		return columnar;
	}
	return {
		dimension,
		source: 'd1',
		sampled: false,
		rows: await d1Breakdown(env, f, dimension, limit),
	};
}
