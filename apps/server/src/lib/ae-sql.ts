// Analytics Engine reads: SQL over HTTP against the dataset `lib/ae.ts` mirrors every accepted event
// into. This is the read half of the columnar store — D1 stays authoritative and answers every
// existing endpoint, and a caller that cannot be served here falls back to it rather than degrading.
//
// THE INJECTION BOUNDARY LIVES HERE. Analytics Engine SQL has no bound parameters: a query is a
// string of text posted to an account-scoped endpoint under a bearer token, so every value a caller
// influences is concatenated into that text or into that URL. Two rules follow, and every builder in
// the codebase goes through them:
//
//   1. A column is never a caller string. Dimensions are resolved through `blobColumn` against the
//      `BLOB_SCHEMA` key set, so the only reachable columns are the twenty the write path fills.
//   2. A value is only interpolated when it is provably inexpressible as syntax. The SQL reference
//      documents string literals as single-quoted and documents NO escape sequence for a quote or a
//      backslash inside one, so there is no escaping rule to implement correctly — `aeLiteral`
//      therefore REFUSES a value containing either, and the caller falls back to D1, which answers
//      it exactly through a bound parameter. Guessing at an undocumented escape would be the one
//      place in this codebase where a query's meaning depends on an unverified vendor behaviour.

import type { Env } from '../env.js';
import { AE_RETENTION_DAYS } from './ae.js';
import { createLogger } from './log.js';
import { retentionDays } from './retention.js';

/** Bound on a single AE read, so a slow or hung analytics API cannot hold a dashboard request open. */
const AE_QUERY_TIMEOUT_MS = 10_000;

/** Cloudflare account ids are 32 lowercase hex characters. This value is interpolated into the API
 * URL PATH, and the request that follows carries `CF_API_TOKEN` — so an id containing `/`, `@`, or a
 * `..` segment could rewrite the request target and hand the token to a host of the operator's
 * typo's choosing. Validated to the exact shape rather than merely non-empty. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** `CF_API_TOKEN` is interpolated into an `authorization` HEADER. A control character in it — a
 * trailing newline off a pasted secret is the ordinary way one gets there — is request-splitting
 * shape rather than a token, so the deployment reports itself unreadable instead of letting `fetch`
 * throw on every read. Printable ASCII, no space: the field-value subset every API token occupies. */
const API_TOKEN = /^[\x21-\x7e]+$/;

/** Rejects any value that could end a `'…'` literal or smuggle syntax into one: a single quote, a
 * backslash (the escape character in every dialect this parser could be built on), or a control
 * character. What remains cannot terminate the literal, so it cannot be read as SQL. */
const UNSAFE_IN_LITERAL = /['\\\p{Cc}]/u;

/** The subset of `fetch` this module uses, injectable so tests drive the client without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Whether this deployment can read from Analytics Engine at all.
 *
 * The binding is required even though a read does not use it: with `AE` unbound nothing was ever
 * mirrored, so a query would report an empty dataset as an empty site. The retention gate is the
 * same one `writeEvent` applies, and for the same reason — below `AE_RETENTION_DAYS` the write path
 * declines, so the dataset holds nothing to read.
 */
export function aeReadable(env: Env): boolean {
	return (
		env.AE_BEST_EFFORT_ENABLED === 'true' &&
		env.AE !== undefined &&
		ACCOUNT_ID.test(env.CF_ACCOUNT_ID ?? '') &&
		API_TOKEN.test(env.CF_API_TOKEN ?? '') &&
		retentionDays(env) >= AE_RETENTION_DAYS
	);
}

/** A quoted string literal, or `null` when the value cannot be expressed as one safely. Callers MUST
 * treat `null` as "this store cannot answer the query" — never as "drop the filter", which would
 * return unfiltered rows under a filtered label. */
export function aeLiteral(value: string): string | null {
	return UNSAFE_IN_LITERAL.test(value) ? null : `'${value}'`;
}

/** An integer literal, or `null` for anything that is not an exact integer (NaN, Infinity, 1e21 —
 * each of which `String()` would happily render into the query as something else). */
export function aeInt(value: number): string | null {
	return Number.isSafeInteger(value) ? String(value) : null;
}

/** The `FORMAT JSON` envelope. `meta`/`rows` are ignored: `data` is the only field a caller reads,
 * and every cell is re-validated by the caller because ClickHouse renders wide integers as strings. */
interface AeSqlResponse {
	data?: unknown;
}

/**
 * Run one query and return its rows, or `null` when the read could not be completed for ANY reason —
 * unconfigured, rejected, timed out, or malformed. There is no error to propagate because there is
 * nothing for a caller to do differently: D1 holds the same events and answers exactly.
 */
export async function queryAe<T>(
	env: Env,
	sql: string,
	fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<T[] | null> {
	if (!aeReadable(env)) {
		return null;
	}
	const log = createLogger({ component: 'ae-sql' });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AE_QUERY_TIMEOUT_MS);
	try {
		const res = await fetchImpl(
			`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${env.CF_API_TOKEN}`,
					'content-type': 'text/plain; charset=utf-8',
				},
				body: sql,
				// IMPORTANT: the bearer token above travels in this request. Following a redirect
				// replays it at whatever host the response names; the analytics API does not
				// redirect, so a 3xx is a fault to decline on rather than a route to take.
				redirect: 'manual',
				signal: controller.signal,
			},
		);
		if (!res.ok) {
			// Status only. The response body of a rejected analytics query echoes the query text, and
			// this deployment's logs are not where a site's paths and referrers should surface.
			log.warn('ae_query_rejected', { status: res.status });
			return null;
		}
		const body = (await res.json()) as AeSqlResponse;
		if (!Array.isArray(body.data)) {
			log.warn('ae_query_malformed');
			return null;
		}
		return body.data as T[];
	} catch (err) {
		log.error('ae_query_failed', err);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Coerce one AE cell to a finite number. Aggregates come back as JSON numbers for doubles but as
 * decimal STRINGS for 64-bit integer sums, so a bare `as number` silently yields `"12"` and every
 * arithmetic on it becomes string concatenation. */
export function aeNumber(cell: unknown): number {
	const n = typeof cell === 'string' || typeof cell === 'number' ? Number(cell) : Number.NaN;
	return Number.isFinite(n) ? n : 0;
}
