// Alert transports: the code that actually gets a payload out of the Worker, plus the SSRF policy
// that decides whether a URL is one we are willing to make a request to at all.
//
// Threat model for the webhook URL: it is operator-supplied, so it is attacker-supplied the moment
// an ADMIN_TOKEN leaks. A Worker that will POST to any URL an admin names is a request forgery
// primitive pointed at whatever the deployment can reach. Hence: https only, no credentials, no
// private/loopback/link-local/reserved address space, no single-label intranet names, and
// `redirect: 'manual'` so a public host cannot 302 us into the blocked space after the check.
//
// Nothing here throws. Every failure is a recorded `DeliveryOutcome`, because delivery must never
// take the cron down with it.

import { EmailMessage } from 'cloudflare:email';
import { ANOMALY_ALERT_TYPE, type AlertPayload } from '@facet/shared';
import { canonicalizeJson, signDetachedJws } from '@facet/trust';
import type { StoredDestination } from '../db/alerts.js';
import type { Env } from '../env.js';
import { toHex } from './crypto.js';
import { getSigningKey } from './signing.js';

/** Delivery timeout in ms. Bounded so one hung endpoint cannot stall the whole cron. */
const DELIVERY_TIMEOUT_MS = 5000 as const;

/**
 * The two OPTIONAL bindings the email transport needs, typed structurally here rather than declared
 * on `Env`. A deployment without Cloudflare Email Routing then carries no obligation whatsoever: the
 * `send_email` binding stays commented out in wrangler.jsonc, `ALERT_EMAIL_FROM` stays unset, and
 * the transport reports `email_unconfigured` rather than pretending to work.
 * (Worth folding into env.ts beside the other optional bindings when that file is next touched.)
 */
interface AlertEmailEnv {
	/** Cloudflare Email Routing `send_email` binding. */
	SEND_EMAIL?: { send(message: unknown): Promise<void> };
	/** Verified sender address on an Email-Routing-enabled zone. */
	ALERT_EMAIL_FROM?: string;
}

/** The subset of `fetch` this module uses, so tests can inject a recorder. */
export type FetchLike = (
	url: string,
	init: RequestInit,
) => Promise<{ ok: boolean; status: number }>;

/** Outcome of one delivery attempt. `error` is a stable short code, safe to persist and surface. */
export interface DeliveryOutcome {
	ok: boolean;
	error?: string;
}

/** Why a webhook URL was refused. Stable codes — returned to the admin API and stored on failures. */
export type UrlRejection =
	| 'malformed_url'
	| 'scheme_not_https'
	| 'credentials_in_url'
	| 'blocked_port'
	| 'blocked_host'
	| 'private_address'
	| 'single_label_host';

/** Hostnames that resolve to the local machine or to a cloud metadata service. */
const BLOCKED_HOSTS = new Set([
	'localhost',
	'ip6-localhost',
	'ip6-loopback',
	'metadata.google.internal',
	'metadata',
]);

/** Suffixes that denote a private/internal naming zone rather than the public DNS. */
const BLOCKED_SUFFIXES = [
	'.localhost',
	'.local',
	'.internal',
	'.intranet',
	'.private',
	'.lan',
	'.corp',
	'.home.arpa',
	'.onion',
];

/**
 * True when a dotted-quad literal is not public unicast. Deliberately covers more than RFC 1918:
 * loopback, link-local (169.254.169.254 is the cloud metadata endpoint), CGNAT, benchmarking,
 * multicast and reserved space are all things a webhook has no business pointing at.
 *
 * Obfuscated forms (`0177.0.0.1`, `2130706433`, `0x7f000001`) do not need special handling: the
 * WHATWG URL parser normalizes every one of them to dotted-quad before we see `hostname`.
 */
function isBlockedIPv4(host: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) {
		return false;
	}
	const [a, b] = [Number(m[1]), Number(m[2])];
	if (a === undefined || b === undefined) {
		return true;
	}
	if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) {
		return true; // not a valid address at all — refuse rather than guess
	}
	if (a === 0 || a === 10 || a === 127) return true; // this-network, RFC 1918, loopback
	if (a === 169 && b === 254) return true; // link-local + cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
	if (a === 192 && b === 168) return true; // RFC 1918
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 192 && b === 0 && Number(m[3]) === 0) return true; // IETF protocol assignments
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a >= 224) return true; // multicast, reserved, broadcast
	return false;
}

/** Expand a canonical (WHATWG-serialized) IPv6 literal into its 8 16-bit groups, or null if it
 * does not parse as one. Only needed for the transition-range unwrap below. */
function expandIPv6Groups(host: string): number[] | null {
	const halves = host.split('::');
	if (halves.length > 2) return null;
	const parseGroups = (s: string): number[] =>
		s === '' ? [] : s.split(':').map((g) => Number.parseInt(g, 16));
	const head = parseGroups(halves[0] ?? '');
	const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
	const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill(0), ...tail];
	return groups.every((g) => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Dotted-quad for two 16-bit groups, high group first. */
function ipv4FromHextets(hi: number, lo: number): string {
	return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * True when an IPv6 literal is not public unicast. Anything written with a leading `::` is
 * special-purpose (`::`, `::1`, and the `::ffff:0:0/96` IPv4-mapped range the URL parser produces
 * for `[::ffff:127.0.0.1]`), so the whole prefix is refused rather than enumerated.
 *
 * 6to4 (2002::/16) and Teredo (2001:0000::/32) both embed an arbitrary client IPv4 IN the address
 * itself (RFC 3056 / RFC 4380), which can smuggle a private/loopback/metadata target past the IPv4
 * blocklist wrapped in a public-looking IPv6 literal — so both are unwrapped and re-checked.
 */
function isBlockedIPv6(bracketed: string): boolean {
	const host = bracketed.slice(1, -1).toLowerCase();
	if (host.startsWith('::')) return true;
	const first = Number.parseInt(host.split(':')[0] ?? '', 16);
	if (!Number.isFinite(first)) return true;
	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	if (host.startsWith('64:ff9b')) return true; // NAT64 — embeds an arbitrary IPv4
	if (first === 0x2002 || first === 0x2001) {
		const groups = expandIPv6Groups(host);
		if (!groups) return true; // can't unwrap a known transition prefix — refuse rather than guess
		if (first === 0x2002) {
			// 6to4: the embedded IPv4 is the 32 bits right after the prefix (groups[1], groups[2]).
			if (isBlockedIPv4(ipv4FromHextets(groups[1] ?? 0, groups[2] ?? 0))) return true;
		} else if (groups[1] === 0) {
			// Teredo (2001:0000::/32 specifically, not every 2001:: prefix): the last 32 bits are the
			// client's IPv4, XORed with 0xFFFFFFFF (RFC 4380 §4).
			const a = (groups[6] ?? 0) ^ 0xffff;
			const b = (groups[7] ?? 0) ^ 0xffff;
			if (isBlockedIPv4(ipv4FromHextets(a, b))) return true;
		}
	}
	return false;
}

/**
 * Validate an operator-supplied webhook URL against the SSRF policy. Returns null when the URL is
 * acceptable, else the reason. Called at creation time AND again immediately before every delivery,
 * because a stored row can predate a tightening of this policy.
 *
 * Residual risk we cannot close in a Worker: DNS rebinding. A name that resolves publicly here can
 * resolve privately at connect time, and Workers cannot resolve-then-connect-to-the-resolved-IP.
 * The Cloudflare egress path is itself the mitigation; this is defence in depth, not the only layer.
 */
export function checkWebhookUrl(raw: string): UrlRejection | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return 'malformed_url';
	}
	// Plaintext http would put the signed payload (and the operator's own data) on the wire in the
	// clear, and it is also the scheme every non-HTTP internal service speaks over a downgrade.
	if (url.protocol !== 'https:') {
		return 'scheme_not_https';
	}
	if (url.username !== '' || url.password !== '') {
		return 'credentials_in_url';
	}
	// Only the default https port. A non-443 port on an operator-named host buys nothing legitimate
	// and turns the alerting cron into a port scanner.
	if (url.port !== '' && url.port !== '443') {
		return 'blocked_port';
	}
	const host = url.hostname.toLowerCase();
	if (host.startsWith('[')) {
		return isBlockedIPv6(host) ? 'private_address' : null;
	}
	if (isBlockedIPv4(host)) {
		return 'private_address';
	}
	const bare = host.endsWith('.') ? host.slice(0, -1) : host;
	if (BLOCKED_HOSTS.has(bare) || BLOCKED_SUFFIXES.some((s) => bare.endsWith(s))) {
		return 'blocked_host';
	}
	// A single-label name (`gitlab`, `router`) can only resolve through a search domain, i.e. inside
	// the deployment's own network.
	if (!bare.includes('.')) {
		return 'single_label_host';
	}
	return null;
}

/** HMAC-SHA256 of `message` under `secret`, lowercase hex. */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
	return toHex(new Uint8Array(sig));
}

/**
 * Build the delivery headers for a canonical body.
 *
 * Two independent authenticity mechanisms, for the two situations a deployment can be in:
 *   • `facet-alert-signature` — HMAC-SHA256 over `<timestamp>.<body>` under the per-destination
 *     secret shown once at creation. Always present. Binding the timestamp INTO the MAC is what
 *     makes replay detectable: a captured delivery cannot be re-dated, so a receiver that rejects a
 *     stale `facet-alert-timestamp` (and remembers `delivery_id`) cannot be replayed at.
 *   • `facet-signature-jws` — detached JWS over the RFC 8785 canonical bytes, signed by the
 *     deployment key. Publicly verifiable against the published JWKS with no shared secret, and the
 *     same primitive/header name the signed-export path already uses (routes/stats.ts). Present
 *     only when FACET_SIGNING_JWK is configured.
 */
async function signingHeaders(
	env: Env,
	dest: StoredDestination,
	payload: AlertPayload,
	body: string,
): Promise<Record<string, string>> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'facet-alert-id': payload.delivery_id,
		'facet-alert-timestamp': String(payload.issued_at),
		'facet-alert-attempt': String(payload.attempt),
	};
	if (dest.secret) {
		const mac = await hmacSha256Hex(dest.secret, `${payload.issued_at}.${body}`);
		headers['facet-alert-signature'] = `v1=${mac}`;
	}
	const loading = getSigningKey(env);
	if (loading) {
		const key = await loading;
		headers['facet-signature-jws'] = await signDetachedJws(new TextEncoder().encode(body), key);
		headers['facet-signing-key-id'] = key.kid;
	}
	return headers;
}

/** POST one signed alert to a webhook destination. Never throws. */
export async function deliverWebhook(
	env: Env,
	dest: StoredDestination,
	payload: AlertPayload,
	fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<DeliveryOutcome> {
	// Re-check at delivery time, not just at creation: the stored row may predate this policy.
	const rejection = checkWebhookUrl(dest.target);
	if (rejection) {
		return { ok: false, error: rejection };
	}
	// RFC 8785 canonical JSON, so the receiver can recompute exactly the bytes that were signed
	// without depending on our key ordering.
	// IMPORTANT: signing is inside a try of its own — a malformed FACET_SIGNING_JWK rejects for the
	// life of the isolate (signing.ts caches the promise), and that must be a recorded failure with
	// its own code, not a throw out of a transport the cron treats as never-throwing.
	let body: string;
	let headers: Record<string, string>;
	try {
		body = canonicalizeJson(payload);
		headers = await signingHeaders(env, dest, payload, body);
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? `sign_failed:${err.name}` : 'sign_failed',
		};
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
	try {
		const res = await fetchImpl(dest.target, {
			method: 'POST',
			headers,
			body,
			// Do NOT follow redirects: the SSRF check above validated THIS url, and a compliant public
			// host can still answer 302 http://169.254.169.254/. A redirect is a failed delivery.
			redirect: 'manual',
			signal: controller.signal,
		});
		return res.ok ? { ok: true } : { ok: false, error: `http_${res.status}` };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? `fetch_failed:${err.name}` : 'fetch_failed',
		};
	} finally {
		clearTimeout(timer);
	}
}

/** Strip CR/LF from a value destined for a MIME header. Header injection: the alert summary is
 * derived from event data (a country/device/channel value), so it is not ours to trust. */
function headerSafe(value: string, max: number): string {
	return value
		.replace(/[\r\n]+/g, ' ')
		.replace(/[^\x20-\x7e]/g, '?')
		.slice(0, max);
}

/** base64 of a UTF-8 string, wrapped to 76-char lines (RFC 2045). Used for the message body so a
 * non-ASCII dimension value in the summary cannot produce an invalid 7-bit message. */
function base64Body(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (const b of bytes) {
		binary += String.fromCharCode(b);
	}
	const b64 = btoa(binary);
	return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

/** One safe, human-readable headline for either alert family. */
function alertSummary(payload: AlertPayload): string {
	if (payload.type === ANOMALY_ALERT_TYPE) return payload.anomaly.summary;
	const o = payload.observation;
	const operator = o.operator === 'at_least' ? 'at least' : 'at most';
	return `${payload.rule.name}: ${o.metric} was ${o.value} (threshold ${operator} ${o.threshold})`;
}

/** Plain-text body of an alert email. */
function emailBody(payload: AlertPayload): string {
	const lines = [
		alertSummary(payload),
		'',
		`severity:      ${payload.severity}`,
		`site:          ${payload.site_id}`,
	];
	if (payload.type === ANOMALY_ALERT_TYPE) {
		const a = payload.anomaly;
		lines.push(
			`metric:        ${a.metric}`,
			`direction:     ${a.direction}`,
			`hour (UTC):    ${new Date(a.bucket).toISOString()}`,
			`value:         ${a.value}`,
			`baseline mean: ${a.baseline_mean}`,
			`z-score:       ${a.z}`,
		);
		if (a.diagnosis) {
			lines.push(
				`contributor:   ${a.diagnosis.dimension}=${a.diagnosis.value} (${a.diagnosis.current} vs ~${Math.round(a.diagnosis.baseline_avg)} typical)`,
			);
		}
	} else {
		const o = payload.observation;
		lines.push(
			`rule:          ${payload.rule.name}`,
			`metric:        ${o.metric}`,
			`operator:      ${o.operator}`,
			`threshold:     ${o.threshold}`,
			`value:         ${o.value}`,
			`window start:  ${new Date(o.window_start).toISOString()}`,
			`window end:    ${new Date(o.window_end).toISOString()}`,
		);
	}
	lines.push('', `delivery id:   ${payload.delivery_id}`, `dedupe key:    ${payload.dedupe_key}`);
	return lines.join('\r\n');
}

/**
 * The complete RFC 5322 message for an alert. Assembled by hand: a mail library would be a new
 * dependency, and a single-part text/plain message is a dozen headers.
 *
 * Every header value that can carry event-derived text goes through `headerSafe`. The anomaly
 * summary embeds a country/device/channel value straight out of the events table, so an ingested
 * `desktop\r\nBcc: …` would otherwise be a header-injection primitive.
 */
export function buildAlertMime(payload: AlertPayload, from: string, to: string): string {
	const domain = from.split('@')[1] ?? 'facet.invalid';
	const subject = headerSafe(`[facet] ${payload.severity}: ${alertSummary(payload)}`, 160);
	return [
		`From: Facet Alerts <${headerSafe(from, 254)}>`,
		`To: ${headerSafe(to, 254)}`,
		`Subject: ${subject}`,
		`Date: ${new Date(payload.issued_at).toUTCString()}`,
		`Message-ID: <${payload.delivery_id}@${headerSafe(domain, 253)}>`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset="utf-8"',
		'Content-Transfer-Encoding: base64',
		'',
		base64Body(emailBody(payload)),
		'',
	].join('\r\n');
}

/**
 * Send an alert through the Cloudflare Email Routing `send_email` binding.
 *
 * Optional by construction: the binding is commented out in wrangler.jsonc (enabling it requires
 * Email Routing on the zone, which not every deployment has), so when either the binding or the
 * from-address var is missing this returns a recorded `email_unconfigured` failure and no email
 * destination ever delivers. It degrades; it never throws and never half-works.
 */
export async function deliverEmail(
	env: Env,
	dest: StoredDestination,
	payload: AlertPayload,
): Promise<DeliveryOutcome> {
	const { SEND_EMAIL: sender, ALERT_EMAIL_FROM: from } = env as Env & AlertEmailEnv;
	if (!sender || !from) {
		return { ok: false, error: 'email_unconfigured' };
	}
	const to = dest.target;
	try {
		// Inside the try: emailBody renders bucket/window timestamps with toISOString(), which throws
		// on a non-finite value rather than degrading the way toUTCString() does.
		const raw = buildAlertMime(payload, from, to);
		await sender.send(new EmailMessage(from, to, raw));
		return { ok: true };
	} catch (err) {
		// `err.name`, not `err.message`: this string is persisted to alert_deliveries.last_error and
		// surfaced, so it stays a bounded stable code like the webhook transport's.
		return {
			ok: false,
			error: err instanceof Error ? `email_failed:${err.name}` : 'email_failed',
		};
	}
}

/** Deliver one alert over its destination's transport. Never throws. */
export async function deliverAlert(
	env: Env,
	dest: StoredDestination,
	payload: AlertPayload,
	fetchImpl?: FetchLike,
): Promise<DeliveryOutcome> {
	try {
		if (dest.type === 'email') {
			return await deliverEmail(env, dest, payload);
		}
		return await deliverWebhook(env, dest, payload, fetchImpl);
	} catch (err) {
		// Belt and braces: a transport is not allowed to surface an exception to the cron.
		return {
			ok: false,
			error: err instanceof Error ? `transport_error:${err.name}` : 'transport_error',
		};
	}
}
