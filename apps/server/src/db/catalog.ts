// Site-scoped catalog reads for goals and funnels, shared by the admin CRUD list and the
// API-key-authenticated dashboard list endpoints (so the dashboard can enumerate a site's goals
// and funnels without the admin token). Reads only; no mutation.

import type {
	Experiment,
	ExperimentVariant,
	FlagConfig,
	FlagRecord,
	FlagRule,
	FlagVariant,
	Funnel,
	FunnelStep,
	Goal,
	PublicFlag,
} from '@facet/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Env } from '../env.js';
import { chunked } from '../lib/constants.js';
import { createLogger } from '../lib/log.js';
import { db } from './queries.js';
import * as schema from './schema.js';

/** Parse a stored JSON array column, or undefined if the row is corrupt. A single malformed row must
 * skip, not fail, the whole list — logged so silent corruption stays visible.
 * IMPORTANT: `JSON.parse` accepts `null`/`42`/`{}`, and a non-array reaches consumers that spread or
 * index it (`evaluateFlag` spreads `rules`), turning a skippable row into a 500. */
function parseJsonColumn<T extends unknown[]>(
	raw: string,
	siteId: string,
	id: string,
	field: string,
): T | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		logParseFailure(err, siteId, id, field);
		return undefined;
	}
	if (!Array.isArray(parsed)) {
		logParseFailure(new Error('not_an_array'), siteId, id, field);
		return undefined;
	}
	return parsed as T;
}

function logParseFailure(err: unknown, siteId: string, id: string, field: string): void {
	createLogger({ component: 'catalog' }).error('catalog_json_parse_failed', err, {
		site_id: siteId,
		id,
		field,
	});
}

/** Whether a site row exists. Lets a public read 404 an unknown site instead of serving an empty
 * catalog, which is indistinguishable from a correctly-configured site that has no rows yet. */
export async function siteExists(env: Env, siteId: string): Promise<boolean> {
	const row = await db(env)
		.select({ id: schema.sites.id })
		.from(schema.sites)
		.where(eq(schema.sites.id, siteId))
		.get();
	return Boolean(row);
}

/** List a site's goals, newest first. */
export async function listGoals(env: Env, siteId: string): Promise<Goal[]> {
	const rows = await db(env)
		.select()
		.from(schema.goals)
		.where(eq(schema.goals.site_id, siteId))
		.orderBy(desc(schema.goals.created_at));
	return rows.map((r) => ({
		id: r.id,
		site_id: r.site_id,
		name: r.name,
		type: r.type as Goal['type'],
		match_value: r.match_value,
		created_at: r.created_at,
	}));
}

/** Fetch one goal by id, or null. Used by `/stats/conversions` to resolve `goal_id` before
 * computing conversions for it; the caller still checks `site_id` ownership itself. */
export async function getGoalById(env: Env, goalId: string): Promise<Goal | null> {
	const row = await db(env).select().from(schema.goals).where(eq(schema.goals.id, goalId)).get();
	if (!row) return null;
	return {
		id: row.id,
		site_id: row.site_id,
		name: row.name,
		type: row.type as Goal['type'],
		match_value: row.match_value,
		created_at: row.created_at,
	};
}

/** Fetch one site's name/domain by id, or null. Used by the `/stats/digest` markdown header. */
export async function getSiteMeta(
	env: Env,
	siteId: string,
): Promise<{ name: string; domain: string } | null> {
	const row = await db(env)
		.select({ name: schema.sites.name, domain: schema.sites.domain })
		.from(schema.sites)
		.where(eq(schema.sites.id, siteId))
		.get();
	return row ?? null;
}

/** List a site's funnels (steps parsed back to arrays), newest first. A funnel whose `steps` column
 * fails to parse is skipped rather than failing the whole list. */
export async function listFunnels(env: Env, siteId: string): Promise<Funnel[]> {
	const rows = await db(env)
		.select()
		.from(schema.funnels)
		.where(eq(schema.funnels.site_id, siteId))
		.orderBy(desc(schema.funnels.created_at));
	return rows
		.map((r) => {
			const steps = parseJsonColumn<FunnelStep[]>(r.steps, siteId, r.id, 'steps');
			if (steps === undefined) return undefined;
			return { id: r.id, site_id: r.site_id, name: r.name, steps, created_at: r.created_at };
		})
		.filter((f): f is Funnel => f !== undefined);
}

/** List a site's experiments (variants parsed, active as boolean), newest first. Skips a row whose
 * `variants` column fails to parse. */
export async function listExperiments(env: Env, siteId: string): Promise<Experiment[]> {
	const rows = await db(env)
		.select()
		.from(schema.experiments)
		.where(eq(schema.experiments.site_id, siteId))
		.orderBy(desc(schema.experiments.created_at));
	return rows
		.map((r) => {
			const variants = parseJsonColumn<ExperimentVariant[]>(
				r.variants,
				siteId,
				r.id,
				'variants',
			);
			if (variants === undefined) return undefined;
			return {
				id: r.id,
				site_id: r.site_id,
				name: r.name,
				flag_key: r.flag_key,
				variants,
				active: r.active === 1,
				created_at: r.created_at,
			};
		})
		.filter((e): e is Experiment => e !== undefined);
}

/** Public flag config: active experiments' flag_key + variants only (client-facing, no auth). */
export async function listActiveExperiments(
	env: Env,
	siteId: string,
): Promise<{ id: string; flag_key: string; variants: ExperimentVariant[] }[]> {
	const rows = await db(env)
		.select()
		.from(schema.experiments)
		.where(and(eq(schema.experiments.site_id, siteId), eq(schema.experiments.active, 1)))
		.orderBy(desc(schema.experiments.created_at));
	return rows
		.map((r) => {
			const variants = parseJsonColumn<ExperimentVariant[]>(
				r.variants,
				siteId,
				r.id,
				'variants',
			);
			if (variants === undefined) return undefined;
			return { id: r.id, flag_key: r.flag_key, variants };
		})
		.filter((e): e is { id: string; flag_key: string; variants: ExperimentVariant[] } =>
			Boolean(e),
		);
}

type FlagRow = typeof schema.flags.$inferSelect;

/** Map a stored flag row into the full admin record (JSON columns parsed, enabled as boolean), or
 * undefined when `variants`/`rules` fails to parse. */
function toFlagRecord(r: FlagRow): FlagRecord | undefined {
	const variants = parseJsonColumn<FlagVariant[]>(r.variants, r.site_id, r.id, 'variants');
	const rules = parseJsonColumn<FlagRule[]>(r.rules, r.site_id, r.id, 'rules');
	if (variants === undefined || rules === undefined) return undefined;
	return {
		id: r.id,
		site_id: r.site_id,
		name: r.name,
		flag_key: r.flag_key,
		type: r.type as FlagRecord['type'],
		enabled: r.enabled === 1,
		default_variant: r.default_variant,
		variants,
		rules,
		salt: r.salt,
		rollout_seed: r.rollout_seed,
		version: r.version,
		created_at: r.created_at,
		updated_at: r.updated_at,
	};
}

/** List a site's flags in full (admin: includes targeting rules + metadata), newest first. */
export async function listFlags(env: Env, siteId: string): Promise<FlagRecord[]> {
	const rows = await db(env)
		.select()
		.from(schema.flags)
		.where(eq(schema.flags.site_id, siteId))
		.orderBy(desc(schema.flags.created_at));
	return rows.map(toFlagRecord).filter((f): f is FlagRecord => f !== undefined);
}

/** Public `/active` payload: enabled flags' non-sensitive bucketing config only — NO targeting rules
 * (those stay server-side and are applied via `/eval`). Everything returned is safe to cache publicly. */
export async function listActiveFlags(env: Env, siteId: string): Promise<PublicFlag[]> {
	const rows = await db(env)
		.select()
		.from(schema.flags)
		.where(and(eq(schema.flags.site_id, siteId), eq(schema.flags.enabled, 1)))
		.orderBy(desc(schema.flags.created_at));
	return rows
		.map((r) => {
			const variants = parseJsonColumn<FlagVariant[]>(r.variants, siteId, r.id, 'variants');
			if (variants === undefined) return undefined;
			return {
				flag_key: r.flag_key,
				type: r.type as PublicFlag['type'],
				enabled: true,
				default_variant: r.default_variant,
				variants,
				salt: r.salt,
				rollout_seed: r.rollout_seed,
				version: r.version,
			};
		})
		.filter((f): f is PublicFlag => f !== undefined);
}

/** Full flag configs (incl. rules) for server-side `/eval`, optionally narrowed to specific keys. */
export async function getEvalFlags(
	env: Env,
	siteId: string,
	keys?: string[],
): Promise<FlagConfig[]> {
	const rows: FlagRow[] = [];
	if (keys && keys.length > 0) {
		// IMPORTANT: `FlagEvalSchema` caps `keys` at 100 and `site_id` binds one more, so an unchunked
		// `IN (...)` sits one over D1's 100-parameter ceiling and the whole evaluation fails.
		for (const batch of chunked([...new Set(keys)])) {
			rows.push(
				...(await db(env)
					.select()
					.from(schema.flags)
					.where(
						and(
							eq(schema.flags.site_id, siteId),
							inArray(schema.flags.flag_key, batch),
						),
					)),
			);
		}
	} else {
		rows.push(
			...(await db(env).select().from(schema.flags).where(eq(schema.flags.site_id, siteId))),
		);
	}
	return rows.map(toFlagRecord).filter((f): f is FlagRecord => f !== undefined);
}
