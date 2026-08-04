// Shared helpers for the admin-API resource commands. The admin token is NEVER logged or printed.

import { fetchJson } from './util.js';

export type FetchJson = <T>(url: string, init?: RequestInit) => Promise<T>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for a canonical (RFC 4122) UUID string. */
export function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

/** Thrown for a user-facing validation/usage failure (missing flag, bad UUID). */
export class UsageError extends Error {}

function isLoopback(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);
}

/**
 * Validate a deployment host and reduce it to a bare origin.
 *
 * WHY this is strict: every caller hands the result to `adminClient`, which puts an ADMIN_TOKEN or an
 * API key in an `Authorization` header. A host that is plain http, or that carries a path or userinfo,
 * therefore decides where a live credential is sent and whether it crosses the wire in the clear. http
 * is allowed only for loopback, which is what `wrangler dev` serves.
 */
export function normalizeHost(host: string): string {
	let url: URL;
	try {
		url = new URL(host);
	} catch {
		throw new UsageError(
			`Invalid host "${host}": expected an absolute URL, e.g. https://facet.example.workers.dev.`,
		);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new UsageError(`Invalid host "${host}": only http and https URLs are supported.`);
	}
	if (url.username !== '' || url.password !== '') {
		throw new UsageError(`Invalid host "${host}": remove the credentials from the URL.`);
	}
	if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
		throw new UsageError(
			`Refusing to use "${host}": the access token would be sent unencrypted. Use https, or a loopback address for \`wrangler dev\`.`,
		);
	}
	if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
		throw new UsageError(
			`Invalid host "${host}": pass only the origin, with no path, query or fragment.`,
		);
	}
	return url.origin;
}

/** Resolve the deployment host from a flag or FACET_HOST. */
export function resolveHost(flag: string | undefined): string {
	const host = flag ?? process.env.FACET_HOST;
	if (!host) {
		throw new UsageError('Missing deployment host: pass --host <url> or set FACET_HOST.');
	}
	return normalizeHost(host);
}

/** Resolve the admin token from a flag or FACET_ADMIN_TOKEN. Never logged or echoed. */
export function resolveAdminToken(flag: string | undefined): string {
	const token = flag ?? process.env.FACET_ADMIN_TOKEN;
	if (!token) {
		throw new UsageError(
			'Missing admin token: pass --admin-token <t> or set FACET_ADMIN_TOKEN.',
		);
	}
	return token;
}

/** Bind an authenticated admin fetcher to a host + token. The token only ever goes into the header. */
export function adminClient(host: string, token: string, fetchImpl: FetchJson = fetchJson) {
	const authHeader = { Authorization: `Bearer ${token}` };
	return {
		get<T>(path: string): Promise<T> {
			return fetchImpl<T>(`${host}${path}`, {
				headers: { ...authHeader },
			});
		},
		post<T>(path: string, body: unknown): Promise<T> {
			return fetchImpl<T>(`${host}${path}`, {
				method: 'POST',
				headers: { ...authHeader, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
		},
		delete<T>(path: string): Promise<T> {
			return fetchImpl<T>(`${host}${path}`, {
				method: 'DELETE',
				headers: { ...authHeader },
			});
		},
	};
}

export type AdminClient = ReturnType<typeof adminClient>;

/** Require a UUID-valued flag, throwing a UsageError with the flag name on missing/invalid. */
export function requireUuid(flag: string, value: string | undefined): string {
	if (!value) {
		throw new UsageError(`Missing required option: --${flag} <uuid>.`);
	}
	if (!isUuid(value)) {
		throw new UsageError(`Invalid --${flag}: "${value}" is not a valid UUID.`);
	}
	return value;
}

/** Require a non-empty string flag, throwing a UsageError with the flag name if absent. */
export function requireString(flag: string, value: string | undefined): string {
	if (value === undefined || value === '') {
		throw new UsageError(`Missing required option: --${flag}.`);
	}
	return value;
}

/** Render a simple left-aligned table (header row + data rows) to a string. */
export function renderTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
	);
	const line = (cells: string[]) =>
		cells
			.map((cell, i) => cell.padEnd(widths[i] ?? 0))
			.join('  ')
			.trimEnd();
	const out = [line(headers)];
	for (const row of rows) out.push(line(row));
	return `${out.join('\n')}\n`;
}
