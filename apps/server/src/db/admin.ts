// Site + site-config admin queries. Split out of routes/admin.ts so D1 access goes through db/
// like every other module, not inline in the route handler.

import type { Site } from '@facet/shared';
import { desc, eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import { db } from './queries.js';
import * as schema from './schema.js';

/** Insert a new site row. */
export async function insertSite(env: Env, site: Site): Promise<void> {
	await db(env).insert(schema.sites).values({
		id: site.id,
		name: site.name,
		domain: site.domain,
		createdAt: site.created_at,
	});
}

/** List every site, newest first. */
export async function listSites(env: Env): Promise<Site[]> {
	return db(env)
		.select({
			id: schema.sites.id,
			name: schema.sites.name,
			domain: schema.sites.domain,
			created_at: schema.sites.createdAt,
		})
		.from(schema.sites)
		.orderBy(desc(schema.sites.createdAt));
}

/** Upsert a site's identity tier + salt window config. */
export async function upsertSiteConfig(
	env: Env,
	siteId: string,
	tier: string,
	saltWindow: string,
	now: number,
): Promise<void> {
	await db(env)
		.insert(schema.siteConfig)
		.values({
			site_id: siteId,
			tier,
			salt_window: saltWindow,
			updated_at: now,
		})
		.onConflictDoUpdate({
			target: schema.siteConfig.site_id,
			set: {
				tier,
				salt_window: saltWindow,
				updated_at: now,
			},
		});
}

/** Whether a team id exists — a site pointed at a nonexistent team grants access to nobody. */
export async function teamExists(env: Env, teamId: string): Promise<boolean> {
	const row = await db(env)
		.select({ id: schema.teams.id })
		.from(schema.teams)
		.where(eq(schema.teams.id, teamId))
		.get();
	return Boolean(row);
}

/** Assign (or unassign, with `teamId: null`) a site's owning team. */
export async function setSiteTeam(env: Env, siteId: string, teamId: string | null): Promise<void> {
	await db(env).update(schema.sites).set({ teamId }).where(eq(schema.sites.id, siteId));
}
