// Experiment (A/B) result aggregation + two-proportion significance test. Exposures and conversions
// are read from the `events` table via `json_extract` on the `props` column (the client fires a
// `$exposure` event carrying `{ flag, variant }`). No server-side identity is used: conversions are
// counted as DISTINCT visitor_hash within the range. All variant values bind as params.

import type { Experiment, ExperimentResult, StatsFilter } from '@facet/shared';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import { db } from './queries.js';
import * as schema from './schema.js';

/** Standard normal CDF via the Zelen–Severo rational approximation. */
export function normalCdf(x: number): number {
	const t = 1 / (1 + 0.2316419 * Math.abs(x));
	const d = 0.3989423 * Math.exp((-x * x) / 2);
	const p =
		d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
	return x > 0 ? 1 - p : p;
}

/** Two-sided two-proportion z-test of variant i vs. control 0. Null when a sample or SE is zero. */
export function twoProportionPValue(c0: number, n0: number, ci: number, ni: number): number | null {
	if (n0 === 0 || ni === 0) {
		return null;
	}
	const p0 = c0 / n0;
	const pi = ci / ni;
	const p = (c0 + ci) / (n0 + ni);
	const se = Math.sqrt(p * (1 - p) * (1 / n0 + 1 / ni));
	if (se === 0) {
		return null;
	}
	const z = (pi - p0) / se;
	return 2 * (1 - normalCdf(Math.abs(z)));
}

/** How a conversion is matched: a custom event name or a visited path. */
export interface ExperimentGoalMatch {
	type: 'event' | 'path';
	value: string;
}

/**
 * Per-variant exposures + conversions for `experiment` over the range, with significance vs. the
 * first (control) variant. Exposures = `$exposure` events tagged with this flag/variant; conversions
 * = distinct visitors who have both an exposure and a goal-matching event in range.
 */
export async function experimentResult(
	env: Env,
	experiment: Experiment,
	goalMatch: ExperimentGoalMatch,
	f: StatsFilter,
): Promise<ExperimentResult> {
	const flag = sql`json_extract(${schema.events.props}, '$.flag')`;
	const variantProp = sql`json_extract(${schema.events.props}, '$.variant')`;

	const perVariant = await Promise.all(
		experiment.variants.map(async (variant) => {
			const exposureWhere = and(
				eq(schema.events.siteId, f.siteId),
				gte(schema.events.createdAt, f.start),
				lt(schema.events.createdAt, f.end),
				eq(schema.events.name, '$exposure'),
				eq(flag, experiment.flag_key),
				eq(variantProp, variant.key),
			);

			const exposureRow = await db(env)
				.select({ count: sql<number>`COUNT(*)` })
				.from(schema.events)
				.where(exposureWhere)
				.get();
			const exposures = Number(exposureRow?.count ?? 0);

			// Distinct visitors with an exposure in this variant AND a goal-matching event in range.
			const converted = sql`EXISTS (
				SELECT 1 FROM ${schema.events} AS g
				WHERE g.site_id = ${schema.events.siteId}
					AND g.visitor_hash = ${schema.events.visitorHash}
					AND g.created_at >= ${f.start}
					AND g.created_at < ${f.end}
					AND ${goalMatch.type === 'event' ? sql`g.name` : sql`g.path`} = ${goalMatch.value}
			)`;
			const conversionRow = await db(env)
				.select({
					count: sql<number>`COUNT(DISTINCT CASE WHEN ${converted} THEN ${schema.events.visitorHash} END)`,
				})
				.from(schema.events)
				.where(exposureWhere)
				.get();
			const conversions = Number(conversionRow?.count ?? 0);

			return {
				key: variant.key,
				exposures,
				conversions,
				rate: exposures === 0 ? 0 : conversions / exposures,
			};
		}),
	);

	const control = perVariant[0];
	const variants = perVariant.map((row, i) => {
		if (i === 0 || !control) {
			return { ...row, p_value: null, significant: false };
		}
		const pValue = twoProportionPValue(
			control.conversions,
			control.exposures,
			row.conversions,
			row.exposures,
		);
		return {
			...row,
			p_value: pValue,
			significant: pValue !== null && pValue < 0.05,
		};
	});

	return { variants };
}
