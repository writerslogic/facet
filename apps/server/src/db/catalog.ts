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
import { db } from './queries.js';
import * as schema from './schema.js';

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

/** List a site's funnels (steps parsed back to arrays), newest first. */
export async function listFunnels(env: Env, siteId: string): Promise<Funnel[]> {
	const rows = await db(env)
		.select()
		.from(schema.funnels)
		.where(eq(schema.funnels.site_id, siteId))
		.orderBy(desc(schema.funnels.created_at));
	return rows.map((r) => ({
		id: r.id,
		site_id: r.site_id,
		name: r.name,
		steps: JSON.parse(r.steps) as FunnelStep[],
		created_at: r.created_at,
	}));
}

/** List a site's experiments (variants parsed, active as boolean), newest first. */
export async function listExperiments(env: Env, siteId: string): Promise<Experiment[]> {
	const rows = await db(env)
		.select()
		.from(schema.experiments)
		.where(eq(schema.experiments.site_id, siteId))
		.orderBy(desc(schema.experiments.created_at));
	return rows.map((r) => ({
		id: r.id,
		site_id: r.site_id,
		name: r.name,
		flag_key: r.flag_key,
		variants: JSON.parse(r.variants) as ExperimentVariant[],
		active: r.active === 1,
		created_at: r.created_at,
	}));
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
	return rows.map((r) => ({
		id: r.id,
		flag_key: r.flag_key,
		variants: JSON.parse(r.variants) as ExperimentVariant[],
	}));
}

type FlagRow = typeof schema.flags.$inferSelect;

/** Map a stored flag row into the full admin record (JSON columns parsed, enabled as boolean). */
function toFlagRecord(r: FlagRow): FlagRecord {
	return {
		id: r.id,
		site_id: r.site_id,
		name: r.name,
		flag_key: r.flag_key,
		type: r.type as FlagRecord['type'],
		enabled: r.enabled === 1,
		default_variant: r.default_variant,
		variants: JSON.parse(r.variants) as FlagVariant[],
		rules: JSON.parse(r.rules) as FlagRule[],
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
	return rows.map(toFlagRecord);
}

/** Public `/active` payload: enabled flags' non-sensitive bucketing config only — NO targeting rules
 * (those stay server-side and are applied via `/eval`). Everything returned is safe to cache publicly. */
export async function listActiveFlags(env: Env, siteId: string): Promise<PublicFlag[]> {
	const rows = await db(env)
		.select()
		.from(schema.flags)
		.where(and(eq(schema.flags.site_id, siteId), eq(schema.flags.enabled, 1)))
		.orderBy(desc(schema.flags.created_at));
	return rows.map((r) => ({
		flag_key: r.flag_key,
		type: r.type as PublicFlag['type'],
		enabled: true,
		default_variant: r.default_variant,
		variants: JSON.parse(r.variants) as FlagVariant[],
		salt: r.salt,
		rollout_seed: r.rollout_seed,
		version: r.version,
	}));
}

/** Full flag configs (incl. rules) for server-side `/eval`, optionally narrowed to specific keys. */
export async function getEvalFlags(
	env: Env,
	siteId: string,
	keys?: string[],
): Promise<FlagConfig[]> {
	const where =
		keys && keys.length > 0
			? and(eq(schema.flags.site_id, siteId), inArray(schema.flags.flag_key, keys))
			: eq(schema.flags.site_id, siteId);
	const rows = await db(env).select().from(schema.flags).where(where);
	return rows.map(toFlagRecord);
}
