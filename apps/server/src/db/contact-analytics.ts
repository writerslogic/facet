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
import { chunked } from '../lib/constants.js';
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
	const client = db(env);
	const summed = { ...EMPTY, top_paths: [] as { path: string; views: number }[] };
	const pathViews = new Map<string, number>();
	// One statement per chunk: an `IN (...)` list is one bound parameter per hash, and D1 refuses a
	// query with more than 100 of them. A company rollup unions every linked contact's live salt
	// windows, so this list is contacts x windows and routinely passes that on a real account.
	for (const batch of chunked(visitorHashes)) {
		const where = and(
			eq(schema.events.siteId, siteId),
			inArray(schema.events.visitorHash, batch),
		);
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
			// Deliberately NOT `LIMIT TOP_PATHS` per chunk. A path in the overall top ten need not be
			// in any single chunk's top ten, so taking a prefix here and merging would return a
			// plausible, subtly wrong ranking. Grouping fully and ranking once at the end is exact,
			// and a visitor set's distinct paths are bounded by the site's own routes.
			client
				.select({
					path: schema.events.path,
					views: sql<number>`count(*)`,
				})
				.from(schema.events)
				.where(where)
				.groupBy(schema.events.path),
		]);
		if (!totals) continue;
		summed.total += totals.total ?? 0;
		summed.pageviews += totals.pageviews ?? 0;
		summed.events += totals.events ?? 0;
		// A hash appears in exactly one chunk, so counts add and the extremes are the extremes.
		summed.first_seen = minDefined(summed.first_seen, totals.first_seen);
		summed.last_seen = maxDefined(summed.last_seen, totals.last_seen);
		for (const row of paths) {
			pathViews.set(row.path, (pathViews.get(row.path) ?? 0) + row.views);
		}
	}
	if (summed.total === 0) return EMPTY;
	return {
		...summed,
		top_paths: [...pathViews]
			.map(([path, views]) => ({ path, views }))
			.sort((a, b) => b.views - a.views || a.path.localeCompare(b.path))
			.slice(0, TOP_PATHS),
	};
}

/** `Math.min` over values that may be absent, where absent means "no opinion" rather than zero. */
function minDefined(a: number | null, b: number | null | undefined): number | null {
	if (a === null || a === undefined) return b ?? null;
	if (b === null || b === undefined) return a;
	return Math.min(a, b);
}

function maxDefined(a: number | null, b: number | null | undefined): number | null {
	if (a === null || a === undefined) return b ?? null;
	if (b === null || b === undefined) return a;
	return Math.max(a, b);
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
	const client = db(env);
	const collected: ContactEvent[] = [];
	// Chunked for D1's bound-parameter limit, as in `contactActivity`. Each chunk takes the full cap
	// rather than a share of it: the newest `CONTACT_EXPORT_MAX_EVENTS` overall could all belong to
	// one chunk, so a per-chunk share would drop rows that belong in the export and the caller's
	// truncation flag would be computed over the wrong set.
	for (const batch of chunked(visitorHashes)) {
		const rows = await client
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
			.where(and(eq(schema.events.siteId, siteId), inArray(schema.events.visitorHash, batch)))
			.orderBy(desc(schema.events.createdAt))
			.limit(CONTACT_EXPORT_MAX_EVENTS);
		collected.push(...rows);
	}
	// Re-rank across chunks, then apply the cap once, so the export is the genuinely newest rows
	// rather than the newest-per-chunk concatenated.
	return collected
		.sort((a, b) => b.created_at - a.created_at)
		.slice(0, CONTACT_EXPORT_MAX_EVENTS);
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
