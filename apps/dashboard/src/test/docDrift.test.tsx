// Documentation-drift guards. Sibling of docs.test.tsx, which tests how the Docs tab BEHAVES; this
// file tests whether what it SAYS is still true.
//
// The failure mode this exists for: a doc claim about a number or a metric definition is written
// correctly, the implementation later changes, and nothing connects the two — so the stale sentence
// survives all the way to a reader. It has already happened here (`form_submit` described as
// counting toward Events when the SQL excludes it; bounce defined as "exactly one pageview" when the
// implementation is `pageviews <= 1`; DNT/GPC described as suppressing collection when the beacon
// gate never consults them).
//
// The mechanism: every claim below names (a) the phrase a reader sees, and (b) the exact symbol in
// the implementation that decides whether the phrase is true. Expected doc text for a numeric claim
// is BUILT from the live constant, so changing `MAX_RANGE_DAYS` makes the guard look for "60 days"
// and fail on the docs' "90 days". Predicate claims quote the extracted SQL/TS back in the failure
// message, so a maintainer sees what the implementation says now without opening a second file.
//
// Every guard fails with a message naming the claim, where it is written and what decides it — see
// `driftError` in ./sourceOfTruth.ts.

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Docs } from '../components/Docs.js';
import {
	type DocClaim,
	blockAfter,
	driftError,
	expressionOf,
	lineWith,
	mountedRoutes,
	numberConst,
	objectKeysAfter,
	pathOf,
	picklistAfter,
	readSource,
	stringConst,
	unionMembersOf,
} from './sourceOfTruth.js';

const DOCS_TSX = 'apps/dashboard/src/components/Docs.tsx';

/** Normalize typographic variation away so a guard pins the CLAIM, not the punctuation: en/em
 * dashes to `-`, smart quotes to straight, all whitespace runs to a single space. */
function normalize(text: string): string {
	return text
		.replace(/[–—]/g, '-')
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Tags that render as their own block. `textContent` concatenates a `<dt>` straight onto its `<dd>`
 * ("…jwks.jsonThe public key…"), inventing words that appear in neither; a space at block boundaries
 * reproduces what a reader actually sees. Inline tags (`code`, `strong`, `em`) are deliberately NOT
 * separated — the prose reads straight through them ("`$`-prefixed"). */
const BLOCK_TAGS = new Set([
	'P',
	'DIV',
	'DL',
	'DT',
	'DD',
	'H1',
	'H2',
	'H3',
	'H4',
	'PRE',
	'UL',
	'OL',
	'LI',
	'SECTION',
	'NAV',
	'BUTTON',
]);

function visibleText(node: Node): string {
	if (node.nodeType === node.TEXT_NODE) return node.nodeValue ?? '';
	const inner = [...node.childNodes].map(visibleText).join('');
	return BLOCK_TAGS.has((node as Element).tagName) ? ` ${inner} ` : inner;
}

// Rendering every section is the only way to read what a reader actually sees (the prose lives in
// JSX, not a string table). Cached across tests: the render is pure and testing-library's per-test
// cleanup does not invalidate an already-extracted string.
let renderedDocs: string | null = null;
function docsText(): string {
	if (renderedDocs === null) {
		const { container } = render(<Docs />);
		renderedDocs = normalize(visibleText(container));
	}
	return renderedDocs;
}

/** Assert the rendered docs contain `phrase`; fail naming the claim and its source of truth. */
function expectDocsToSay(claim: DocClaim, phrase: string): void {
	if (docsText().includes(normalize(phrase))) return;
	throw driftError(claim, `the docs to contain "${normalize(phrase)}"`, 'no such phrase');
}

/** Assert the rendered docs do NOT contain `phrase` — used to pin a claim against the specific
 * wrong wording it regressed from before. */
function expectDocsNotToSay(claim: DocClaim, phrase: string): void {
	if (!docsText().includes(normalize(phrase))) return;
	throw driftError(
		claim,
		`the docs NOT to contain "${normalize(phrase)}" (the older, wrong wording)`,
		`the docs say "${normalize(phrase)}"`,
	);
}

/** Assert a markdown doc contains `phrase`. */
function expectMarkdownToSay(claim: DocClaim, file: 'apiMd', phrase: string): void {
	if (normalize(readSource(file)).includes(normalize(phrase))) return;
	throw driftError(claim, `${pathOf(file)} to contain "${normalize(phrase)}"`, 'no such phrase');
}

/** Strip ALL whitespace, not collapse it: the formatter can wrap a call right after its opening
 * paren, introducing a space there that collapsing alone would still leave behind. Safe because
 * `requires`/`forbids` needles are code shapes (a call, an SQL fragment), never prose where a word
 * boundary carries meaning. */
function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, '');
}

/** Assert an extracted implementation fragment does/doesn't contain the parts the claim rests on.
 * The fragment is quoted verbatim (not whitespace-collapsed) in the failure so the reader sees the
 * current implementation as it actually appears in the file. */
function expectSourceToSatisfy(
	claim: DocClaim,
	fragment: string,
	rules: { requires?: string[]; forbids?: string[] },
): void {
	const normalizedFragment = normalizeWhitespace(fragment);
	for (const needle of rules.requires ?? []) {
		if (normalizedFragment.includes(normalizeWhitespace(needle))) continue;
		throw driftError(
			claim,
			`the implementation to contain \`${needle}\``,
			`${claim.decidedBy} is now:\n                   ${fragment}`,
		);
	}
	for (const needle of rules.forbids ?? []) {
		if (!normalizedFragment.includes(normalizeWhitespace(needle))) continue;
		throw driftError(
			claim,
			`the implementation NOT to contain \`${needle}\``,
			`${claim.decidedBy} is now:\n                   ${fragment}`,
		);
	}
}

// =================================================================================================
// 1. Documented constants derive from the constant that defines them.
// =================================================================================================

interface ConstantClaim extends DocClaim {
	/** Phrases the docs must contain, BUILT from the live constant — so changing the constant
	 * changes what the docs are required to say. */
	phrases: () => string[];
}

const CONSTANT_CLAIMS: ConstantClaim[] = [
	{
		claim: 'a stats query may not exceed MAX_RANGE_DAYS days',
		shownIn: `${DOCS_TSX} › "API reference" and "Troubleshooting"`,
		decidedBy: 'apps/server/src/lib/constants.ts › MAX_RANGE_DAYS',
		phrases: () => {
			const days = numberConst('serverConstants', 'MAX_RANGE_DAYS');
			return [`may not exceed ${days} days`, `caps any single query at ${days} days`];
		},
	},
	{
		claim: 'raw events are purged past DEFAULT_RAW_RETENTION_DAYS days',
		shownIn: `${DOCS_TSX} › "Troubleshooting" › The date range won't go back further`,
		decidedBy: 'apps/server/src/lib/constants.ts › DEFAULT_RAW_RETENTION_DAYS',
		phrases: () => [
			`(${numberConst('serverConstants', 'DEFAULT_RAW_RETENTION_DAYS')} days by default)`,
		],
	},
	{
		claim: 'a props object holds at most PROPS_MAX_KEYS keys',
		shownIn: `${DOCS_TSX} › "Custom events & props" and "Troubleshooting"`,
		decidedBy: 'packages/shared/src/schemas.ts › PROPS_MAX_KEYS',
		phrases: () => {
			const n = numberConst('sharedSchemas', 'PROPS_MAX_KEYS');
			return [`At most ${n} keys`, `more than ${n} keys`];
		},
	},
	{
		claim: 'a props key is at most PROPS_KEY_MAX_LEN characters',
		shownIn: `${DOCS_TSX} › "Custom events & props" and "Troubleshooting"`,
		decidedBy: 'packages/shared/src/schemas.ts › PROPS_KEY_MAX_LEN',
		phrases: () => {
			const n = numberConst('sharedSchemas', 'PROPS_KEY_MAX_LEN');
			return [`each key 1-${n} characters`, `a key over ${n} characters`];
		},
	},
	{
		claim: 'a string prop value is at most PROPS_STR_MAX_LEN characters',
		shownIn: `${DOCS_TSX} › "Custom events & props" and "Troubleshooting"`,
		decidedBy: 'packages/shared/src/schemas.ts › PROPS_STR_MAX_LEN',
		phrases: () => {
			const n = numberConst('sharedSchemas', 'PROPS_STR_MAX_LEN');
			return [`A string of at most ${n} characters`, `a string value over ${n}`];
		},
	},
	{
		claim: 'an event name is 1-128 characters',
		shownIn: `${DOCS_TSX} › "Custom events & props" › Event name`,
		decidedBy: 'packages/shared/src/schemas.ts › CollectPayloadSchema.name',
		phrases: () => {
			// The `name` field of the beacon payload, whose bounds the glossary quotes.
			const field = lineWith('sharedSchemas', 'name: v.optional(v.pipe(v.string()');
			const min = /minLength\((\d+)\)/.exec(field)?.[1];
			const max = /maxLength\((\d+)\)/.exec(field)?.[1];
			return [`${min}-${max} characters`];
		},
	},
	{
		claim: 'a new session starts after a SESSION_TIMEOUT_MS inactivity gap',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Sessions`,
		decidedBy: 'apps/server/src/lib/constants.ts › SESSION_TIMEOUT_MS',
		phrases: () => {
			const minutes = numberConst('serverConstants', 'SESSION_TIMEOUT_MS') / 60_000;
			return [`inactivity gap over ${minutes} minutes`];
		},
	},
	{
		claim: 'realtime counts the trailing REALTIME_WINDOW_MS window',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Active visitors, and "A tour of the tabs"`,
		decidedBy: 'apps/server/src/lib/constants.ts › REALTIME_WINDOW_MS',
		phrases: () => {
			const minutes = numberConst('serverConstants', 'REALTIME_WINDOW_MS') / 60_000;
			const words =
				['zero', 'one', 'two', 'three', 'four', 'five'][minutes] ?? String(minutes);
			return [`trailing ${minutes}-minute window`, `in the last ${words} minutes`];
		},
	},
	{
		claim: 'every API key carries the API_KEY_PREFIX prefix',
		shownIn: `${DOCS_TSX} › "Sites & API keys" and "API reference"`,
		decidedBy: 'apps/server/src/lib/constants.ts › API_KEY_PREFIX',
		phrases: () => [`(prefix ${stringConst('serverConstants', 'API_KEY_PREFIX')})`],
	},
	{
		claim: 'an export breakdown limit runs from 1 to EXPORT_MAX_ROWS, defaulting to 100',
		shownIn: `${DOCS_TSX} › "Exporting data" › Over the API`,
		decidedBy:
			'apps/server/src/lib/constants.ts › EXPORT_MAX_ROWS + routes/stats.ts export default',
		phrases: () => {
			const max = numberConst('serverConstants', 'EXPORT_MAX_ROWS');
			const fallback = /limitRaw !== undefined \? Number\(limitRaw\) : (\d+)/.exec(
				readSource('statsRoutes'),
			)?.[1];
			return [`from 1 to ${max} (default ${fallback})`];
		},
	},
	{
		claim: 'the stats interval defaults to hour for ranges within the hourly threshold',
		shownIn: `${DOCS_TSX} › "API reference"`,
		decidedBy: 'apps/server/src/routes/stats.ts › interval fallback (`<= N * HOUR_MS`)',
		phrases: () => {
			const hours = /<= (\d+) \* HOUR_MS/.exec(readSource('statsRoutes'))?.[1];
			return [`ranges of ${hours} hours or less`];
		},
	},
	{
		claim: 'a repeated SPA pageview within REPEAT_PAGEVIEW_MS is collapsed',
		shownIn: `${DOCS_TSX} › "What the snippet captures automatically" › SPA navigations`,
		decidedBy: 'packages/client/src/auto.ts › REPEAT_PAGEVIEW_MS',
		phrases: () => [
			`within ${numberConst('clientAuto', 'REPEAT_PAGEVIEW_MS')} ms is collapsed`,
		],
	},
	{
		claim: 'the realtime tab refetches every REFETCH_MS',
		shownIn: `${DOCS_TSX} › "A tour of the tabs" › Realtime`,
		decidedBy: 'apps/dashboard/src/hooks/realtime.ts › REFETCH_MS',
		phrases: () => {
			const seconds = numberConst('dashboardRealtime', 'REFETCH_MS') / 1000;
			return [`refreshing every ${seconds} seconds`];
		},
	},
	{
		claim: 'an experiment carries between 2 and 8 weighted variants',
		shownIn: `${DOCS_TSX} › "Experiments vs feature flags"`,
		decidedBy: 'packages/shared/src/schemas.ts › ExperimentSchema.variants',
		phrases: () => {
			const field = lineWith('sharedSchemas', 'v.array(ExperimentVariantSchema)');
			const min = /minLength\((\d+)\)/.exec(field)?.[1];
			const max = /maxLength\((\d+)\)/.exec(field)?.[1];
			return [`${min}-${max} weighted variants`];
		},
	},
	{
		claim: 'the opt-out kill switch lives under the OPTOUT_KEY localStorage key',
		shownIn: `${DOCS_TSX} › "Privacy, opt-out & consent" › Opt-out`,
		decidedBy: 'packages/client/src/optout.ts › OPTOUT_KEY',
		phrases: () => [`localStorage['${stringConst('clientOptout', 'OPTOUT_KEY')}']`],
	},
	{
		claim: 'the experiment bucketing id lives under the client STORAGE_KEY localStorage key',
		shownIn: `${DOCS_TSX} › "Experiments vs feature flags"`,
		decidedBy: 'packages/client/src/id.ts › STORAGE_KEY',
		phrases: () => [`localStorage['${stringConst('clientId', 'STORAGE_KEY')}']`],
	},
];

describe('Documented constants match the constant that defines them', () => {
	for (const claim of CONSTANT_CLAIMS) {
		it(claim.claim, () => {
			for (const phrase of claim.phrases()) expectDocsToSay(claim, phrase);
		});
	}
});

describe('docs/api.md numbers match the constant that defines them', () => {
	const apiMdClaims: ConstantClaim[] = [
		{
			claim: 'docs/api.md states the range cap as MAX_RANGE_DAYS',
			shownIn: 'docs/api.md › Error envelope + GET /api/stats',
			decidedBy: 'apps/server/src/lib/constants.ts › MAX_RANGE_DAYS',
			phrases: () => {
				const days = numberConst('serverConstants', 'MAX_RANGE_DAYS');
				return [`exceeds the ${days}-day maximum`, `${days}-day range cap`];
			},
		},
		{
			claim: 'docs/api.md states the collect body cap as COLLECT_MAX_BODY_BYTES',
			shownIn: 'docs/api.md › POST /api/collect',
			decidedBy: 'apps/server/src/lib/constants.ts › COLLECT_MAX_BODY_BYTES',
			phrases: () => {
				const bytes = numberConst('serverConstants', 'COLLECT_MAX_BODY_BYTES');
				return [`Collect body exceeded ${bytes} bytes`, `over **${bytes} bytes**`];
			},
		},
		{
			claim: 'docs/api.md states the CORS preflight cache as CORS_MAX_AGE',
			shownIn: 'docs/api.md › POST /api/collect',
			decidedBy: 'apps/server/src/lib/constants.ts › CORS_MAX_AGE',
			phrases: () => {
				const hours = numberConst('serverConstants', 'CORS_MAX_AGE') / 3600;
				return [`preflight cached ${hours}h`];
			},
		},
		{
			claim: 'docs/api.md states the props limits as the shared schema defines them',
			shownIn: 'docs/api.md › POST /api/collect body table',
			decidedBy:
				'packages/shared/src/schemas.ts › PROPS_MAX_KEYS / PROPS_KEY_MAX_LEN / PROPS_STR_MAX_LEN',
			phrases: () => {
				const keys = numberConst('sharedSchemas', 'PROPS_MAX_KEYS');
				const keyLen = numberConst('sharedSchemas', 'PROPS_KEY_MAX_LEN');
				const strLen = numberConst('sharedSchemas', 'PROPS_STR_MAX_LEN');
				return [`≤ ${keys} keys, keys 1-${keyLen} chars, values string ≤ ${strLen}`];
			},
		},
		{
			claim: 'docs/api.md states the Ask question length cap enforced by the route',
			shownIn: 'docs/api.md › POST /api/stats/query',
			decidedBy: 'apps/server/src/routes/stats.ts › body.question.length guard',
			phrases: () => {
				const max = /body\.question\.length > (\d+)/.exec(readSource('statsRoutes'))?.[1];
				return [`"question": string (1-${max} chars)`];
			},
		},
		{
			claim: 'docs/api.md states the session split threshold as SESSION_TIMEOUT_MS',
			shownIn: 'docs/api.md › Sessions & engagement',
			decidedBy: 'apps/server/src/lib/constants.ts › SESSION_TIMEOUT_MS',
			phrases: () => {
				const minutes = numberConst('serverConstants', 'SESSION_TIMEOUT_MS') / 60_000;
				return [`exceeds **${minutes} minutes** (\`SESSION_TIMEOUT_MS\`)`];
			},
		},
	];
	for (const claim of apiMdClaims) {
		it(claim.claim, () => {
			for (const phrase of claim.phrases()) expectMarkdownToSay(claim, 'apiMd', phrase);
		});
	}
});

// =================================================================================================
// 2. Metric definitions match the predicate that computes them.
//
// This is the class of error that actually shipped: prose describing a metric one way while the SQL
// predicate behind it says something else. Each entry pins BOTH sides — the wording a reader sees
// and the predicate that decides it — so either half changing alone is a failure.
// =================================================================================================

interface PredicateClaim extends DocClaim {
	/** Phrases the docs must contain for the claim to be stated at all. */
	docSays: string[];
	/** Wordings the claim previously regressed to, or that would contradict it. */
	docMustNotSay?: string[];
	/** The implementation fragment that decides the claim, extracted verbatim. */
	implementation: () => string;
	requires?: string[];
	forbids?: string[];
}

const PREDICATE_CLAIMS: PredicateClaim[] = [
	{
		claim: 'Pageviews counts beacons with no event name',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Pageviews`,
		decidedBy: 'apps/server/src/db/stats.ts › pageviewCount',
		docSays: ['Every beacon with no event name'],
		implementation: () => expressionOf('statsSql', 'pageviewCount'),
		requires: ['events.name} IS NULL'],
		forbids: ['IS NOT NULL'],
	},
	{
		claim: 'Events excludes form_submit and every $-prefixed internal event',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Events, and "Custom events & props"`,
		decidedBy: 'apps/server/src/db/stats.ts › isCustomEvent',
		docSays: [
			'form_submit and every $-prefixed internal event are excluded',
			'are excluded from the Events metric',
		],
		docMustNotSay: ['form_submit counts toward Events', 'including form_submit'],
		implementation: () => expressionOf('statsSql', 'isCustomEvent'),
		// Each fragment is one half of a claim in the prose: named-only, no internals, no form_submit.
		requires: ['IS NOT NULL', "NOT LIKE '$%'", "<> 'form_submit'"],
	},
	{
		claim: 'Interactions is the exact complement of Events: form_submit plus $-prefixed events',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Interactions`,
		decidedBy: 'apps/server/src/db/stats.ts › isInteraction',
		docSays: ['The complement of Events: auto-tracked form_submit plus Facet’s own $exposure'],
		implementation: () => expressionOf('statsSql', 'isInteraction'),
		requires: ['IS NOT NULL', "LIKE '$%'", "= 'form_submit'"],
		// A stray NOT/<> here would make Interactions the same set as Events, not its complement.
		forbids: ['NOT LIKE', '<>'],
	},
	{
		claim: 'the top-events breakdown uses the same exclusion as the Events metric',
		shownIn: `${DOCS_TSX} › "Custom events & props"`,
		decidedBy: 'apps/server/src/db/stats.ts › topEvents',
		docSays: ['excluded from the Events metric and the top-events breakdown'],
		implementation: () => blockAfter('statsSql', 'export function topEvents('),
		requires: ['extra: isCustomEvent'],
	},
	{
		claim: 'Visitors is a count of distinct visitor hashes',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Visitors`,
		decidedBy: 'apps/server/src/db/stats.ts › visitorCount',
		docSays: ['A salted hash of IP + user agent + site'],
		implementation: () => expressionOf('statsSql', 'visitorCount'),
		requires: ['COUNT(DISTINCT', 'visitorHash'],
	},
	{
		claim: 'a bounce is a session with one pageview OR FEWER, not exactly one',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Bounce rate`,
		decidedBy: 'apps/server/src/lib/sessions.ts › isBounce',
		docSays: [
			'one pageview or fewer',
			'A session made only of custom events, with no pageview at all, counts as a bounce',
		],
		// The exact wording this regressed to before. `<= 1` also admits zero-pageview sessions.
		docMustNotSay: ['exactly one pageview'],
		implementation: () => lineWith('sessions', 'isBounce:'),
		requires: ['pageviews <= 1'],
		forbids: ['pageviews === 1', 'pageviews == 1'],
	},
	{
		claim: 'bounce rate is bounces divided by sessions over materialized sessions',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Bounce rate`,
		decidedBy: 'apps/server/src/db/stats.ts › engagement',
		docSays: ['Share of sessions with one pageview or fewer'],
		implementation: () => blockAfter('statsSql', 'export async function engagement('),
		requires: ['bounce_rate: Number(row?.bounces ?? 0) / sessions', 'eventSessions'],
	},
	{
		claim: 'session duration spans a session’s first to last event, so single-event sessions are 0',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Pages / session, Avg duration`,
		decidedBy: 'apps/server/src/lib/sessions.ts › durationMs',
		docSays: [
			'Duration is the span from a session’s first to last event, so single-event sessions contribute zero',
		],
		implementation: () => lineWith('sessions', 'durationMs:'),
		requires: ['endedAt - startedAt'],
	},
	{
		claim: 'a session splits on an inactivity gap STRICTLY EXCEEDING the timeout',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Sessions`,
		decidedBy: 'apps/server/src/lib/sessions.ts › gapExceeded',
		docSays: ['splitting on any inactivity gap over 30 minutes'],
		implementation: () => lineWith('sessions', 'const gapExceeded'),
		requires: ['> SESSION_TIMEOUT_MS'],
		forbids: ['>= SESSION_TIMEOUT_MS'],
	},
	{
		claim: 'the Channels breakdown counts SESSIONS and omits the internal channel',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Channels`,
		decidedBy: 'apps/server/src/db/stats.ts › channels',
		docSays: [
			'The breakdown counts sessions, not events, and omits internal',
			'its total is externally-acquired sessions, not all sessions',
		],
		implementation: () => blockAfter('statsSql', 'export async function channels('),
		requires: ['schema.eventSessions', "ne(schema.eventSessions.channel, 'internal')"],
	},
	{
		claim: 'realtime active visitors are distinct hashes over the trailing window',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Active visitors (Realtime)`,
		decidedBy: 'apps/server/src/db/stats.ts › realtime + routes/stats.ts /stats/realtime',
		docSays: ['Distinct visitor hashes in the trailing 5-minute window'],
		implementation: () =>
			`${blockAfter('statsSql', 'export async function realtime(')}\n${lineWith(
				'statsRoutes',
				'realtime(c.env, siteId, Date.now()',
			)}`,
		requires: ['visitors: visitorCount', 'now - windowMs', 'REALTIME_WINDOW_MS'],
	},
	{
		claim: 'a breakdown dimension is only surfaced above the k-anonymity floor',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Visitors (upper bound under a slice)`,
		decidedBy: 'apps/server/src/db/stats.ts › K_ANON',
		docSays: ['Under a dimension slice it is an upper bound'],
		implementation: () =>
			`${lineWith('statsSql', 'export const K_ANON')}\n${blockAfter('statsSql', 'export function topBrowsers(')}`,
		requires: ['minCount: K_ANON'],
	},
	{
		claim: 'retention depth is bounded by the salt window, so daily rotation gives ~0',
		shownIn: `${DOCS_TSX} › "A tour of the tabs" › Retention, and "Troubleshooting"`,
		decidedBy: 'apps/server/src/db/stats.ts › SALT_WINDOW_NOTE',
		docSays: [
			'Depth is bounded by your salt window',
			'at the default daily rotation cross-day retention is legitimately near zero, not a bug',
		],
		implementation: () => blockAfter('statsSql', 'const SALT_WINDOW_NOTE', '\n\n'),
		requires: ['salt window', 'daily'],
	},
	{
		claim: 'the visitor salt rotates per UTC day by default',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Visitors`,
		decidedBy: 'apps/server/src/lib/salt.ts › getDailySalt (keyed by UTC dayKey)',
		docSays: ['the salt rotating on a schedule (daily by default)'],
		implementation: () => blockAfter('salt', 'export async function getDailySalt('),
		requires: ['SELECT salt FROM salts WHERE day_key = ?'],
	},
	{
		claim: 'session-derived analytics materialize on an hourly cron',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Sessions, and "Troubleshooting"`,
		decidedBy: 'apps/server/src/db/stats.ts › sessionFreshness',
		docSays: ['materialized by an hourly cron', 'materialize on an hourly cron'],
		implementation: () => blockAfter('statsSql', 'export async function sessionFreshness('),
		requires: ["materialization: 'hourly'"],
	},
	{
		claim: 'a signed export is refused rather than silently returned unsigned',
		shownIn: `${DOCS_TSX} › "Exporting data" › Signed exports`,
		decidedBy: 'apps/server/src/routes/stats.ts › ?sign=1 handler',
		docSays: ['501 signing_unavailable'],
		implementation: () =>
			blockAfter('statsRoutes', "if (c.req.query('sign') === '1')", '\n\t}'),
		requires: ["ApiError('signing_unavailable', 501"],
	},
	{
		claim: 'flagBool is true only when the assigned variant is exactly `on`',
		shownIn: `${DOCS_TSX} › "Experiments vs feature flags"`,
		decidedBy: 'packages/client/src/flags.ts › flagBool',
		docSays: ['true only when the variant is exactly'],
		implementation: () => lineWith('clientFlags', "=== 'on'"),
		requires: ["=== 'on'"],
	},
	{
		claim: 'an $exposure fires at most once per flag per page load',
		shownIn: `${DOCS_TSX} › "Experiments vs feature flags"`,
		decidedBy: 'packages/client/src/experiments.ts › assignment (exposed set)',
		docSays: ['fired at most once per flag per page load'],
		implementation: () => blockAfter('clientExperiments', 'export function assignment('),
		requires: ['if (!exposed.has(flagKey))', "track('$exposure'"],
	},
	// ---------------------------------------------------------------------------------------------
	// DNT / GPC. This claim has been wrong in five separate places (privacy.md, usage.md,
	// standards.md, Docs.tsx and a signed RATS attestation). The beacon gate is the whole question:
	// `isExplicitlyOptedOut` must consult ONLY the deliberate controls. If a DNT/GPC read is ever
	// added to it, "still counted" becomes false everywhere at once — so pin the gate itself.
	// ---------------------------------------------------------------------------------------------
	{
		claim: 'DNT/GPC do NOT suppress collection — the beacon gate never consults them',
		shownIn: `${DOCS_TSX} › "Privacy, opt-out & consent" › Do Not Track & Global Privacy Control`,
		decidedBy: 'packages/client/src/optout.ts › isExplicitlyOptedOut',
		docSays: ['does not suppress the anonymous, cookieless pageview'],
		docMustNotSay: [
			'DNT/GPC dropped the beacon',
			'no event is written',
			'suppresses the pageview',
		],
		implementation: () => blockAfter('clientOptout', 'export function isExplicitlyOptedOut('),
		// Only the two DELIBERATE controls: the localStorage kill switch and the script attribute.
		requires: ['safeGet(OPTOUT_KEY)', 'scriptOptOut()'],
		// The passive browser signal must not reach this gate — that is exactly the regression.
		forbids: ['browserSignalOptOut', 'doNotTrack', 'globalPrivacyControl'],
	},
	{
		claim: 'DNT/GPC do gate experiments and feature flags',
		shownIn: `${DOCS_TSX} › "Privacy, opt-out & consent" › Do Not Track & Global Privacy Control`,
		decidedBy: 'packages/client/src/experiments.ts + flags.ts › isOptedOut gates',
		docSays: ['experiments and flags are never evaluated'],
		implementation: () =>
			`${blockAfter('clientExperiments', 'function loadFlags(')}\n${lineWith(
				'clientFlags',
				'if (isOptedOut())',
			)}`,
		requires: ['if (isOptedOut())'],
	},
	{
		claim: 'a GPC visitor is pinned to the anonymous Tier-0 hash server-side',
		shownIn: `${DOCS_TSX} › "Privacy, opt-out & consent" › Do Not Track & Global Privacy Control`,
		decidedBy: 'apps/server/src/lib/ingest.ts › deriveForIngest',
		docSays: [
			'the visitor is pinned to the anonymous Tier-0 hash and can never be identity-elevated',
		],
		implementation: () => blockAfter('ingest', 'async function deriveForIngest('),
		requires: ["policy.tier === 'anonymous' || input.gpc"],
	},
	{
		claim: 'neither ingest route drops an event on a GPC signal',
		shownIn: 'docs/api.md › POST /api/collect and POST /api/event',
		decidedBy: 'apps/server/src/routes/collect.ts + routes/event.ts › gpc handling',
		docSays: [],
		implementation: () =>
			`${blockAfter('collectRoute', 'const gpc = isGpcOptOut', '\n\t\tconst body')}` +
			`\n${blockAfter('eventRoute', 'const gpc = isGpcOptOut', '\n\t\tconst body')}`,
		// The signal is computed and passed to ingest; an early `return` here would be the old,
		// documented-away behaviour coming back.
		forbids: ['return c.body(null, 202)'],
	},
	{
		claim: 'the signed RATS evidence labels DNT/GPC as personalization-disabling, not "honored"',
		shownIn: `${DOCS_TSX} › "Privacy, opt-out & consent" › Do Not Track & Global Privacy Control`,
		decidedBy: 'apps/server/src/lib/attestation.ts › PRIVACY_TRANSFORMS',
		docSays: ['dnt-gpc-disable-personalization', 'gpc-forces-anonymous-identity'],
		docMustNotSay: ['dnt-honored', 'gpc-honored'],
		implementation: () =>
			blockAfter('attestation', 'const PRIVACY_TRANSFORMS', '\n] as const;'),
		requires: ['dnt-gpc-disable-personalization', 'gpc-forces-anonymous-identity'],
		forbids: ["'dnt-honored'", "'gpc-honored'"],
	},
	{
		claim: 'an auto-tracked form_submit reads no field values',
		shownIn: `${DOCS_TSX} › "What the snippet captures automatically" › Form submissions`,
		decidedBy: 'packages/client/src/auto.ts › submit listener',
		docSays: [
			'carrying only form_id, form_name and action',
			'No field values are ever read',
			'Opt a form out with data-facet-ignore',
		],
		implementation: () => blockAfter('clientAuto', "track('form_submit'", '\n\t\t\t});'),
		requires: ['form_id: form.id', "form_name: form.getAttribute('name')", 'action:'],
		// `form.elements` / `FormData` / a value read would make the "no field values" claim false.
		forbids: ['form.elements', 'FormData', '.value'],
	},
];

describe('Metric and behaviour definitions match the predicate that computes them', () => {
	for (const claim of PREDICATE_CLAIMS) {
		it(claim.claim, () => {
			for (const phrase of claim.docSays) expectDocsToSay(claim, phrase);
			for (const phrase of claim.docMustNotSay ?? []) expectDocsNotToSay(claim, phrase);
			expectSourceToSatisfy(claim, claim.implementation(), {
				requires: claim.requires,
				forbids: claim.forbids,
			});
		});
	}
});

// =================================================================================================
// 3. Enumerations the docs spell out in full, pinned to the enumeration itself.
//
// These are two-way: the expected sentence is BUILT by joining the live members, so adding,
// removing or reordering a member fails the guard.
// =================================================================================================

interface EnumClaim extends DocClaim {
	members: () => string[];
	/** Render the members exactly as the docs phrase them. */
	phrase: (members: string[]) => string;
}

const ENUM_CLAIMS: EnumClaim[] = [
	{
		claim: 'the traffic-channel list names every Channel',
		shownIn: `${DOCS_TSX} › "What the metrics mean" › Channels`,
		decidedBy: 'apps/server/src/lib/channel.ts › type Channel',
		members: () => unionMembersOf('channel', 'Channel'),
		phrase: (m) => `into ${m.slice(0, -1).join(', ')} or ${m[m.length - 1]}`,
	},
	{
		claim: 'the viewport screen tiers match the collect schema allowlist',
		shownIn: `${DOCS_TSX} › "What the snippet captures automatically" › Viewport class`,
		decidedBy: 'packages/shared/src/schemas.ts › CollectPayloadSchema.screen',
		members: () => picklistAfter('sharedSchemas', 'screen: v.optional(v.picklist('),
		phrase: (m) => `a screen tier (${m.join(' / ')})`,
	},
	{
		claim: 'the DPR classes match the collect schema allowlist',
		shownIn: `${DOCS_TSX} › "What the snippet captures automatically" › Viewport class`,
		decidedBy: 'packages/shared/src/schemas.ts › CollectPayloadSchema.dpr',
		members: () => picklistAfter('sharedSchemas', 'dpr: v.optional(v.picklist('),
		phrase: (m) => `a DPR class (${m.join(' / ')})`,
	},
	{
		claim: 'the salt windows match SaltWindowSchema, and there is deliberately no "never"',
		shownIn: `${DOCS_TSX} › "Privacy, opt-out & consent" › Identity tiers`,
		decidedBy: 'packages/shared/src/schemas.ts › SaltWindowSchema',
		members: () => picklistAfter('sharedSchemas', 'export const SaltWindowSchema'),
		phrase: (m) => `widens the window to ${m.join('/')}`,
	},
	{
		claim: 'the export breakdown dimensions match EXPORT_DIMENSIONS',
		shownIn: `${DOCS_TSX} › "Exporting data" › Over the API`,
		decidedBy: 'apps/server/src/routes/stats.ts › EXPORT_DIMENSIONS',
		members: () => objectKeysAfter('statsRoutes', 'const EXPORT_DIMENSIONS'),
		phrase: (m) => `a dimension of ${m.slice(0, -1).join(', ')} or ${m[m.length - 1]}`,
	},
];

describe('Enumerations the docs spell out match the enumeration itself', () => {
	for (const claim of ENUM_CLAIMS) {
		it(claim.claim, () => {
			const members = claim.members();
			if (members.length === 0) throw driftError(claim, 'a non-empty enumeration', 'none');
			expectDocsToSay(claim, claim.phrase(members));
		});
	}

	it('the salt window enumeration contains no unbounded "never"', () => {
		const claim: DocClaim = {
			claim: 'linkage is always bounded by retention — there is no "never" salt window',
			shownIn: `${DOCS_TSX} › "Privacy, opt-out & consent" › Identity tiers`,
			decidedBy: 'packages/shared/src/schemas.ts › SaltWindowSchema',
		};
		const members = picklistAfter('sharedSchemas', 'export const SaltWindowSchema');
		if (members.includes('never')) {
			throw driftError(
				claim,
				'no `never` member',
				`SaltWindowSchema = ${members.join(', ')}`,
			);
		}
		expectDocsToSay(claim, 'There is deliberately no "never" window');
	});

	it('the identity tiers named in the docs match IdentityTierSchema', () => {
		const claim: DocClaim = {
			claim: 'the identity spectrum has exactly the tiers the docs name',
			shownIn: `${DOCS_TSX} › "Privacy, opt-out & consent" › Identity tiers`,
			decidedBy: 'packages/shared/src/schemas.ts › IdentityTierSchema',
		};
		for (const tier of picklistAfter('sharedSchemas', 'export const IdentityTierSchema')) {
			expectDocsToSay(claim, tier.charAt(0).toUpperCase() + tier.slice(1));
		}
	});

	it('every flag-evaluation reason the docs list exists in an implementation', () => {
		const claim: DocClaim = {
			claim: 'flagAssignment().reason is one of the documented values',
			shownIn: `${DOCS_TSX} › "Experiments vs feature flags"`,
			decidedBy:
				'packages/client/src/flags.ts + packages/shared/src/flags.ts + apps/server/src/routes/flags.ts',
		};
		// The reason strings are produced in three places; the docs list them as one union.
		const produced = [
			readSource('clientFlags'),
			readSource('sharedFlags'),
			readSource('flagRoutes'),
		].join('\n');
		for (const reason of ['pending', 'opted-out', 'unknown', 'disabled', 'rollout', 'gpc']) {
			if (produced.includes(`reason: '${reason}'`)) continue;
			throw driftError(claim, `some source to produce reason: '${reason}'`, 'no producer');
		}
		if (!produced.includes('reason: `rule:${rule.priority}`')) {
			throw driftError(claim, 'a source to produce a `rule:<n>` reason', 'no producer');
		}
		expectDocsToSay(
			claim,
			'pending | opted-out | unknown | disabled | rollout | rule:<n> | gpc',
		);
	});
});

// =================================================================================================
// 4. Endpoint coverage. Routes are derived from the route table, never listed here — a router added
// to registry.ts by anyone shows up on the next run.
// =================================================================================================

describe('Endpoint documentation matches the mounted route table', () => {
	it('docs/api.md documents every route mounted in routes/registry.ts', () => {
		const md = readSource('apiMd');
		const undocumented = mountedRoutes().filter((route) => {
			// A GET-only discovery document is documented as a bare path in a table (the well-known
			// set), so a path mention is enough there; anything that mutates must name its method,
			// because the method is the part a caller can get wrong.
			if (md.includes(`${route.method} ${route.path}`)) return false;
			return !(route.method === 'GET' && md.includes(route.path));
		});
		if (undocumented.length === 0) return;
		throw driftError(
			{
				claim: 'docs/api.md is the complete endpoint reference',
				shownIn: 'docs/api.md',
				decidedBy: 'apps/server/src/routes/registry.ts › ROUTES (and each sub-router)',
			},
			'every mounted route to appear in docs/api.md',
			`${undocumented.length} undocumented:\n${undocumented
				.map((r) => `                     ${r.method} ${r.path}  (${r.source})`)
				.join('\n')}\nDocument them in docs/api.md; do not delete this guard.`,
		);
	});

	it('docs/api.md documents no endpoint that has been removed', () => {
		const mounted = mountedRoutes();
		// Only headings are checked: prose mentions a path in many incidental ways, but a `##`/`###`
		// heading is a promise that the endpoint exists.
		const documented = [
			...readSource('apiMd').matchAll(/^#{2,3} `(GET|POST|PUT|PATCH|DELETE) (\/[^`?\s]*)/gm),
		].map((m) => ({ method: m[1] as string, path: m[2] as string }));
		const stale = documented.filter(
			(d) => !mounted.some((r) => r.method === d.method && r.path === d.path),
		);
		if (stale.length === 0) return;
		throw driftError(
			{
				claim: 'every endpoint with a section in docs/api.md still exists',
				shownIn: 'docs/api.md § headings',
				decidedBy: 'apps/server/src/routes/registry.ts › ROUTES (and each sub-router)',
			},
			'every documented endpoint to be mounted',
			`${stale.length} documented but not mounted:\n${stale
				.map((d) => `                     ${d.method} ${d.path}`)
				.join('\n')}`,
		);
	});

	it('every endpoint the Docs tab names is a real mounted route', () => {
		const mountedPaths = new Set(mountedRoutes().map((r) => r.path));
		// Paths as they appear in the in-app prose. Trailing punctuation is stripped; a `:param`
		// segment in the prose is matched structurally against the mounted pattern.
		const named = new Set(
			[...docsText().matchAll(/(?:\/api|\/\.well-known)\/[\w./:-]+/g)]
				.map((m) => (m[0] as string).replace(/[.,]$/, ''))
				.filter((p) => !p.endsWith('/')),
		);
		const unknown = [...named].filter((p) => !mountedPaths.has(p));
		if (unknown.length === 0) return;
		throw driftError(
			{
				claim: 'the Docs tab only names endpoints that exist',
				shownIn: `${DOCS_TSX}`,
				decidedBy: 'apps/server/src/routes/registry.ts › ROUTES (and each sub-router)',
			},
			'every path named in the in-app docs to be mounted',
			`not mounted: ${unknown.join(', ')}`,
		);
	});
});

// A cheap smoke assertion so the suite reports coverage even if every table above were emptied.
describe('Doc-drift guard coverage', () => {
	it('pins a non-trivial number of claims', () => {
		expect(
			CONSTANT_CLAIMS.length + PREDICATE_CLAIMS.length + ENUM_CLAIMS.length,
		).toBeGreaterThan(30);
	});
});
