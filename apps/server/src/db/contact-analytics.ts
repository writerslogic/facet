// The analytics half of the CRM link. Given visitor hashes that `lib/consent.ts` has already
// verified a contact may be linked to, summarise (and, for a data-subject export, list) that
// person's events from the ANALYTICS database.
//
// This file deliberately takes hashes as an argument rather than a contact or an external user id.
// It has no way to resolve one itself, so there is no path through it that skips the consent check —
// the only caller that can produce its input is the one that verified a signed grant first. An empty
// hash list is a normal input and returns an empty summary; that is what an unconsented contact, and
// equally a contact whose consent record retention has already purged, looks like from here.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import { db } from './queries.js';
import * as schema from './schema.js';
import { eventCount, pageviewCount } from './stats.js';

/** Upper bound on the events a single data-subject export may enumerate. An export is a bounded
 * artifact; when the person has more events than this the response says so rather than silently
 * returning a prefix that reads like the whole record. */
export const CONTACT_EXPORT_MAX_EVENTS = 1000;

/** How many of a company's contacts one rollup resolves consent for. Each one costs a signature
 * verification, so an unbounded fan-out is a CPU-limit failure waiting for the largest account. The
 * response says when it bit, because a truncated aggregate is a lower bound and not a total. */
export const COMPANY_ROLLUP_MAX_CONTACTS = 100;

/** How many distinct paths a contact summary lists. */
const TOP_PATHS = 10;

export interface ContactActivity {
	pageviews: number;
	/** Custom (named) events only, NOT the total. Same split `/api/stats` reports, so the two agree. */
	events: number;
	/** Every row, pageviews plus custom events — what `top_paths` is counted over. */
	total: number;
	first_seen: number | null;
	last_seen: number | null;
	top_paths: { path: string; views: number }[];
}

const EMPTY: ContactActivity = {
	pageviews: 0,
	events: 0,
	total: 0,
	first_seen: null,
	last_seen: null,
	top_paths: [],
};

/** Aggregate a linked contact's activity. Scoped by BOTH site and hash: a hash is site-specific by
 * construction (siteId is in every pre-image), and the redundant site predicate keeps that true even
 * if a caller ever passes a hash it obtained elsewhere. */
export async function contactActivity(
	env: Env,
	siteId: string,
	visitorHashes: string[],
): Promise<ContactActivity> {
	if (visitorHashes.length === 0) return EMPTY;
	const where = and(
		eq(schema.events.siteId, siteId),
		inArray(schema.events.visitorHash, visitorHashes),
	);
	const client = db(env);
	const [totals, paths] = await Promise.all([
		client
			// The SAME expressions /api/stats uses, imported rather than rewritten. A pageview is
			// `name IS NULL` in this schema, so a hand-rolled `name = 'pageview'` would silently
			// report zero pageviews for every real visitor — and the two surfaces would disagree
			// about one person's numbers while agreeing about everyone's.
			.select({
				total: sql<number>`count(*)`,
				pageviews: pageviewCount,
				events: eventCount,
				first_seen: sql<number>`min(${schema.events.createdAt})`,
				last_seen: sql<number>`max(${schema.events.createdAt})`,
			})
			.from(schema.events)
			.where(where)
			.get(),
		client
			.select({
				path: schema.events.path,
				views: sql<number>`count(*)`,
			})
			.from(schema.events)
			.where(where)
			.groupBy(schema.events.path)
			.orderBy(desc(sql`count(*)`))
			.limit(TOP_PATHS),
	]);
	if (!totals || totals.total === 0) return EMPTY;
	return {
		pageviews: totals.pageviews ?? 0,
		events: totals.events ?? 0,
		total: totals.total,
		first_seen: totals.first_seen ?? null,
		last_seen: totals.last_seen ?? null,
		top_paths: paths,
	};
}

/** One event row as it appears in a data-subject export. */
export interface ContactEvent {
	created_at: number;
	hostname: string;
	path: string;
	referrer: string;
	name: string | null;
	country: string | null;
	device: string | null;
	channel: string | null;
}

/** The events behind a contact's summary, newest first, capped at `CONTACT_EXPORT_MAX_EVENTS`. The
 * caller compares `events.length` against the summary's total to report truncation explicitly. */
export async function contactEvents(
	env: Env,
	siteId: string,
	visitorHashes: string[],
): Promise<ContactEvent[]> {
	if (visitorHashes.length === 0) return [];
	return db(env)
		.select({
			created_at: schema.events.createdAt,
			hostname: schema.events.hostname,
			path: schema.events.path,
			referrer: schema.events.referrer,
			name: schema.events.name,
			country: schema.events.country,
			device: schema.events.device,
			channel: schema.events.channel,
		})
		.from(schema.events)
		.where(
			and(
				eq(schema.events.siteId, siteId),
				inArray(schema.events.visitorHash, visitorHashes),
			),
		)
		.orderBy(desc(schema.events.createdAt))
		.limit(CONTACT_EXPORT_MAX_EVENTS);
}

/** The consent records authorizing a contact's linkage, for the export. The signed statement is
 * PII-FREE (its claims are the derived hash, tier and window — never an email or a raw uid), so
 * including it verbatim gives the data subject cryptographic evidence of what they consented to
 * without widening what the export discloses. The raw `external_user_id` column is deliberately not
 * selected: the caller already knows it, and it does not belong in an artifact that gets emailed. */
export async function contactConsentRecords(
	env: Env,
	siteId: string,
	externalUserId: string,
): Promise<Record<string, unknown>[]> {
	const rows = await db(env)
		.select({
			tier: schema.consentRecords.tier,
			salt_window: schema.consentRecords.salt_window,
			window_key: schema.consentRecords.window_key,
			granted_at: schema.consentRecords.granted_at,
			expires_at: schema.consentRecords.expires_at,
			revoked_at: schema.consentRecords.revoked_at,
			statement: schema.consentRecords.statement,
		})
		.from(schema.consentRecords)
		.where(
			and(
				eq(schema.consentRecords.site_id, siteId),
				eq(schema.consentRecords.external_user_id, externalUserId),
			),
		)
		.orderBy(desc(schema.consentRecords.granted_at));
	return rows.map((row) => {
		let statement: unknown = null;
		try {
			statement = JSON.parse(row.statement);
		} catch {
			// A statement that no longer parses is still a fact about this person's record, so the
			// row stays in the export with a null statement rather than vanishing from it.
		}
		return { ...row, statement };
	});
}
