// POST /api/import — historical backfill from another analytics tool (umami, Plausible, GA4, …),
// behind the admin token. Deliberately NOT the write-scoped `/api/event` path with a `timestamp`
// field: backdating rewrites history, so it is an operator capability, not something a leaked site
// key can do. Rows go through the same derivation as live ingest, so an imported visitor is hashed
// (under the `import:` pre-image and that day's salt) and never stored in identifiable form.

import { IMPORT_MAX_DAYS, ImportSchema } from '@facet/shared';
import { vValidator } from '@hono/valibot-validator';
import { Hono } from 'hono';
import { siteExists } from '../db/catalog.js';
import type { AppEnv } from '../env.js';
import { requireAdmin } from '../lib/auth.js';
import { DAY_MS } from '../lib/constants.js';
import { ApiError, validationErrorHook } from '../lib/http.js';
import { type DerivedEvent, deriveEvent, persistDerived } from '../lib/ingest.js';
import { device } from '../lib/request-meta.js';
import { retentionDays } from '../lib/retention.js';
import { rollupBucket } from '../lib/rollups.js';
import { dayKey, getDailySalt } from '../lib/salt.js';
import { buildSessionsForSiteDay } from '../lib/sessions.js';
import { hasLoggedRollupKey, rollupKey } from '../lib/transparency.js';

// D1 caps statements per batch, and `persistDerived` emits two per event (the row + its session), so
// the batch is chunked rather than sent as one 1000-statement transaction.
const PERSIST_CHUNK = 100;

const IMPORT_NOTE =
	"Imported visitors are hashed under the destination site's per-day salt, so cross-day unique " +
	'visitors and cohort retention over the imported range are not recoverable — each day of history ' +
	'counts its own uniques. Daily rollups and sessions are rebuilt for the imported days; hourly ' +
	'rollups are not backfilled, so hour-granularity history predates this import.';

function dayStartMs(key: string): number {
	return Date.parse(`${key}T00:00:00.000Z`);
}

export const importRoutes = new Hono<AppEnv>();

importRoutes.post(
	'/',
	requireAdmin,
	vValidator('json', ImportSchema, validationErrorHook),
	async (c) => {
		const { site_id: siteId, events, dry_run: dryRun } = c.req.valid('json');
		// An event whose site does not exist would flip `/api/ready`'s referential-integrity check to
		// 503, so the site is verified before a single row is derived.
		if (!(await siteExists(c.env, siteId))) {
			throw new ApiError('site_not_found', 404, 'unknown site_id');
		}

		const now = Date.now();
		const retention = retentionDays(c.env);
		const cutoff = now - retention * DAY_MS;
		let oldest = Number.POSITIVE_INFINITY;
		let newest = Number.NEGATIVE_INFINITY;
		for (const e of events) {
			if (e.timestamp < oldest) oldest = e.timestamp;
			if (e.timestamp > newest) newest = e.timestamp;
		}
		// Rejected, not silently trimmed: rows older than the retention window would be deleted by the
		// next `enforceRetention` run, so accepting them would report an import that quietly evaporates.
		// IMPORTANT: the bound is the oldest UTC day's MIDNIGHT, not the oldest row. `enforceRetention`
		// cuts raw events at an instant while `event_rollups` is durable history that is never deleted,
		// so a day straddling the cutoff has already lost its pre-cutoff rows — and the day rebuild below
		// recomputes the whole bucket from what survives, overwriting that durable rollup with an
		// undercount for every site with traffic that day, not just this one.
		const oldestDay = dayKey(oldest);
		if (dayStartMs(oldestDay) < cutoff) {
			throw new ApiError(
				'out_of_retention',
				400,
				`batch reaches UTC day ${oldestDay}, which is not wholly inside the ${retention}-day retention window`,
			);
		}
		if (newest > now) {
			throw new ApiError('future_timestamp', 400, 'an event is dated in the future');
		}

		// Ascending, because `sessions` inserts are `onConflictDoNothing` on (site, hash, day): the first
		// row to land fixes `first_seen`, and an out-of-order batch would fix it on the wrong event and
		// therefore the wrong entry path. Grouping by day preserves that order (the map is filled from
		// the sorted list) while giving the salt lookup below one entry per day instead of one per row.
		const byDay = new Map<string, typeof events>();
		for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
			const key = dayKey(e.timestamp);
			const bucket = byDay.get(key);
			if (bucket) bucket.push(e);
			else byDay.set(key, [e]);
		}
		const days = [...byDay.keys()];
		if (days.length > IMPORT_MAX_DAYS) {
			throw new ApiError(
				'too_many_days',
				400,
				`batch spans ${days.length} UTC days, over the ${IMPORT_MAX_DAYS}-day per-request limit`,
			);
		}
		// A transparency leaf commits the absolute counters of a daily rollup. Rebuilding that day after
		// it was logged would change the row while the unique leaf key continued to attest the old hash.
		// Reject before deriving or writing anything, including for dry runs, so imports are atomic with
		// respect to the signed history boundary.
		const affectedRollups = events.map((event) =>
			rollupKey({
				siteId,
				hostname: event.hostname,
				bucketStart: dayStartMs(dayKey(event.timestamp)),
				interval: 'day',
			}),
		);
		if (await hasLoggedRollupKey(c.env, affectedRollups)) {
			throw new ApiError(
				'signed_history_conflict',
				409,
				'one or more imported UTC days already have a signed transparency-log rollup',
			);
		}
		if (dryRun) {
			return c.json({
				imported: 0,
				skipped: 0,
				duplicates: 0,
				days,
				dry_run: true,
				note: IMPORT_NOTE,
			});
		}

		const url = new URL(c.req.url);
		// Keyed by the content-addressed id, so two identical rows in ONE file collapse the same way a
		// re-import does and `imported` reports rows written rather than rows derived.
		const derived = new Map<string, DerivedEvent>();
		let skipped = 0;
		let duplicates = 0;
		for (const [key, dayEvents] of byDay) {
			// One salt lookup per DAY, not per event: the isolate salt cache holds three keys and evicts
			// blind, so a per-event lookup over a month-long batch would be a D1 round-trip every row.
			// Created with the day's own midnight as `created_at`, so a salt minted for a historical day
			// is purged by retention on the same schedule as the events it protects, never outliving them.
			const salt = await getDailySalt(c.env, key, dayStartMs(key));
			for (const e of dayEvents) {
				const ua = e.user_agent ?? '';
				const row = await deriveEvent(c.env, {
					siteId,
					ip: '',
					ua,
					hostname: e.hostname,
					path: e.path,
					referrer: e.referrer ?? '',
					name: e.name ?? null,
					props: e.props ?? null,
					utm: e.utm ?? null,
					country: e.country ?? null,
					// `device()` answers 'desktop' for an empty UA, which would label a whole import that
					// carried no user-agents as desktop traffic. Unknown stays null.
					device: ua === '' ? null : device(ua),
					now: e.timestamp,
					gpc: false,
					url,
					historical: { visitorId: e.visitor_id, salt },
				});
				if (!row) skipped++;
				else if (derived.has(row.id)) duplicates++;
				else derived.set(row.id, row);
			}
		}

		const rows = [...derived.values()];
		for (let i = 0; i < rows.length; i += PERSIST_CHUNK) {
			await persistDerived(c.env, rows.slice(i, i + PERSIST_CHUNK));
		}

		// The cron only ever rolls up and sessionizes the hour/day that just closed, so imported history
		// would otherwise reach `/api/stats` (which reads raw events) but never `event_rollups` or
		// `event_sessions`. Both operations are idempotent upserts, so this composes with the cron.
		for (const key of days) {
			const start = dayStartMs(key);
			await rollupBucket(c.env, 'day', start, start + DAY_MS);
			await buildSessionsForSiteDay(c.env, siteId, key);
		}

		return c.json({ imported: rows.length, skipped, duplicates, days, note: IMPORT_NOTE });
	},
);
