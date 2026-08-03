// Doc-drift plumbing. Documentation goes stale silently because prose and code are edited in
// different files, often by different people, and nothing connects them. This module reads the REAL
// implementation off disk (node:fs — no new dependency) so a documentation guard can assert against
// the value a constant actually has, or the predicate that actually computes a metric, rather than
// against a second hand-maintained copy of it.
//
// Every reader here fails LOUDLY when its anchor moves: a renamed constant or a restructured
// predicate throws "source of truth moved" instead of quietly matching nothing. That is deliberate —
// a guard that stops finding its anchor and passes anyway is worse than no guard, because it implies
// coverage that does not exist.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo-relative paths of every file a doc claim is checked against. Keyed by a short alias so a
 * failure message can name the real path without the call sites repeating it. */
const SOURCES = {
	serverConstants: 'apps/server/src/lib/constants.ts',
	sharedSchemas: 'packages/shared/src/schemas.ts',
	sharedFlags: 'packages/shared/src/flags.ts',
	statsSql: 'apps/server/src/db/stats.ts',
	anomalySql: 'apps/server/src/db/anomaly.ts',
	sessions: 'apps/server/src/lib/sessions.ts',
	statsRoutes: 'apps/server/src/routes/stats.ts',
	funnelRoutes: 'apps/server/src/routes/funnels.ts',
	flagRoutes: 'apps/server/src/routes/flags.ts',
	registry: 'apps/server/src/routes/registry.ts',
	channel: 'apps/server/src/lib/channel.ts',
	salt: 'apps/server/src/lib/salt.ts',
	attestation: 'apps/server/src/lib/attestation.ts',
	collectRoute: 'apps/server/src/routes/collect.ts',
	eventRoute: 'apps/server/src/routes/event.ts',
	ingest: 'apps/server/src/lib/ingest.ts',
	clientAuto: 'packages/client/src/auto.ts',
	clientOptout: 'packages/client/src/optout.ts',
	clientId: 'packages/client/src/id.ts',
	clientFlags: 'packages/client/src/flags.ts',
	clientExperiments: 'packages/client/src/experiments.ts',
	dashboardRealtime: 'apps/dashboard/src/hooks/realtime.ts',
	apiMd: 'docs/api.md',
} as const;

export type SourceAlias = keyof typeof SOURCES;

/** Repo-relative path for an alias — used verbatim in failure messages, so it must stay accurate. */
export function pathOf(alias: SourceAlias): string {
	return SOURCES[alias];
}

// The test file's own location is the only reliable anchor: `process.cwd()` differs depending on
// whether vitest is invoked from the workspace root or from apps/dashboard.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const cache = new Map<SourceAlias, string>();

/** Read a source file, cached. Throws with the resolved path when the file has moved. */
export function readSource(alias: SourceAlias): string {
	const hit = cache.get(alias);
	if (hit !== undefined) return hit;
	const rel = SOURCES[alias];
	let text: string;
	try {
		text = readFileSync(join(REPO_ROOT, rel), 'utf8');
	} catch {
		throw new Error(
			[
				`SOURCE OF TRUTH MOVED: ${rel} no longer exists (resolved from ${REPO_ROOT}).`,
				'The documentation guards read it to check the docs against the implementation.',
				'Point SOURCES in apps/dashboard/src/test/sourceOfTruth.ts at the new location.',
			].join('\n'),
		);
	}
	cache.set(alias, text);
	return text;
}

function anchorMissing(alias: SourceAlias, what: string): Error {
	return new Error(
		[
			`SOURCE OF TRUTH MOVED: could not find ${what} in ${SOURCES[alias]}.`,
			'A documentation guard is anchored to it and can no longer verify the claim it covers.',
			'Re-anchor the guard in apps/dashboard/src/test/docDrift.test.tsx (and check whether',
			'the docs still describe the new behaviour) rather than deleting it.',
		].join('\n'),
	);
}

/** A numeric `const NAME = 1_234` (export optional), with `_` separators stripped. */
export function numberConst(alias: SourceAlias, name: string): number {
	const m = new RegExp(`\\bconst ${name}(?::[^=]*)? = ([0-9_]+)`).exec(readSource(alias));
	if (!m?.[1]) throw anchorMissing(alias, `numeric constant \`${name}\``);
	return Number(m[1].replace(/_/g, ''));
}

/** A single-quoted `const NAME = 'value'` (export optional). */
export function stringConst(alias: SourceAlias, name: string): string {
	const m = new RegExp(`\\bconst ${name}(?::[^=]*)? = '([^']*)'`).exec(readSource(alias));
	if (m?.[1] === undefined) throw anchorMissing(alias, `string constant \`${name}\``);
	return m[1];
}

/** The right-hand side of a `const NAME = …;` declaration, verbatim. This is how a metric's SQL
 * predicate is pinned: the extracted text is quoted back in the failure message, so a maintainer
 * sees exactly what the implementation says now. */
export function expressionOf(alias: SourceAlias, name: string): string {
	const m = new RegExp(`\\bconst ${name}(?::[^=]*)? = ([\\s\\S]*?);\\n`).exec(readSource(alias));
	if (!m?.[1]) throw anchorMissing(alias, `expression \`${name} = …\``);
	return m[1].trim();
}

/** The source from `marker` up to `end` (default: the first line-initial `}`), i.e. a function or
 * object-literal body. Used where a claim is decided by several lines rather than one expression. */
export function blockAfter(
	alias: SourceAlias,
	marker: string,
	end: string | RegExp = /\n\}/,
): string {
	const src = readSource(alias);
	const at = src.indexOf(marker);
	if (at === -1) throw anchorMissing(alias, `\`${marker}\``);
	const rest = src.slice(at);
	const stop = typeof end === 'string' ? rest.indexOf(end) : rest.search(end);
	if (stop === -1) throw anchorMissing(alias, `the end of the block starting at \`${marker}\``);
	return rest.slice(0, stop + (typeof end === 'string' ? end.length : 1));
}

/** The first source line containing `needle`. */
export function lineWith(alias: SourceAlias, needle: string): string {
	const line = readSource(alias)
		.split('\n')
		.find((l) => l.includes(needle));
	if (line === undefined) throw anchorMissing(alias, `a line containing \`${needle}\``);
	return line.trim();
}

/** The members of the first `v.picklist([...])` at or after `marker`, in declaration order. */
export function picklistAfter(alias: SourceAlias, marker: string): string[] {
	const src = readSource(alias);
	const at = src.indexOf(marker);
	if (at === -1) throw anchorMissing(alias, `\`${marker}\``);
	const m = /v\.picklist\(\[([\s\S]*?)\]\)/.exec(src.slice(at));
	if (!m?.[1]) throw anchorMissing(alias, `a picklist after \`${marker}\``);
	return [...m[1].matchAll(/'([^']*)'/g)].map((q) => q[1] as string);
}

/** The string members of a `type Name = 'a' | 'b' | …` union, in declaration order. */
export function unionMembersOf(alias: SourceAlias, typeName: string): string[] {
	const m = new RegExp(`\\btype ${typeName} =([^;]*);`).exec(readSource(alias));
	if (!m?.[1]) throw anchorMissing(alias, `string-union type \`${typeName}\``);
	return [...m[1].matchAll(/'([^']*)'/g)].map((q) => q[1] as string);
}

/** The keys of an object literal introduced by `marker` (e.g. a route/dimension table). */
export function objectKeysAfter(alias: SourceAlias, marker: string): string[] {
	const block = blockAfter(alias, marker, '\n};');
	return [...block.matchAll(/^\t(\w+):/gm)].map((m) => m[1] as string);
}

// ---------------------------------------------------------------------------------------------
// Mounted HTTP routes, derived from the route table rather than a hand-kept list.
// ---------------------------------------------------------------------------------------------

export interface MountedRoute {
	method: string;
	/** Full path as mounted, e.g. `GET /api/stats/export` → `/api/stats/export`. */
	path: string;
	/** Repo-relative file the handler is declared in. */
	source: string;
}

const HTTP_METHODS = 'get|post|put|patch|delete|options|all';

/** Every route the Worker actually mounts, read from `routes/registry.ts` plus the sub-router each
 * entry names. Deliberately derived, not listed: a router added to the registry by anyone shows up
 * here on the next test run without this file being touched.
 *
 * Two shapes are handled: routers that declare handlers directly (`xRoutes.get('/y', …)`) and
 * routers produced by `crudRouter()`, whose POST `/` + GET `/` + DELETE `/:id` contract lives in
 * `lib/crud.ts`. */
export function mountedRoutes(): MountedRoute[] {
	const registry = readSource('registry');
	const registryPath = SOURCES.registry;

	// identifier → repo-relative file it is imported from.
	const importedFrom = new Map<string, string>();
	for (const m of registry.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([\w-]+)\.js'/g)) {
		for (const name of (m[1] as string).split(',')) {
			importedFrom.set(name.trim(), `apps/server/src/routes/${m[2]}.ts`);
		}
	}

	const entries = [...registry.matchAll(/\{\s*path:\s*'([^']+)'\s*,\s*router:\s*(\w+)\s*\}/g)];
	if (entries.length === 0)
		throw anchorMissing('registry', 'any `{ path, router }` ROUTES entry');

	const routes: MountedRoute[] = [];
	for (const entry of entries) {
		const mount = entry[1] as string;
		const ident = entry[2] as string;
		// A router defined inline in the registry (health) has no import entry.
		const file = importedFrom.get(ident) ?? registryPath;
		const src = readFileSync(join(REPO_ROOT, file), 'utf8');
		const add = (method: string, sub: string) => {
			routes.push({
				method: method.toUpperCase(),
				path: `${mount}${sub === '/' ? '' : sub}` || '/',
				source: file,
			});
		};
		if (new RegExp(`\\bconst ${ident}\\b[^=]*=\\s*crudRouter\\(`).test(src)) {
			for (const [method, sub] of [
				['post', '/'],
				['get', '/'],
				['delete', '/:id'],
			] as const) {
				add(method, sub);
			}
		}
		const handler = new RegExp(`\\b${ident}\\.(${HTTP_METHODS})\\(\\s*'([^']*)'`, 'g');
		for (const m of src.matchAll(handler)) add(m[1] as string, m[2] as string);
	}
	return routes;
}

// ---------------------------------------------------------------------------------------------
// Failure reporting.
// ---------------------------------------------------------------------------------------------

export interface DocClaim {
	/** The claim in one line, phrased the way a reader would state it. */
	claim: string;
	/** Where a reader encounters the claim. */
	shownIn: string;
	/** `repo/relative/path.ts › symbol` — what decides whether the claim is true. */
	decidedBy: string;
}

/** A failure a future maintainer can act on without reading this file: what was claimed, where a
 * reader sees it, what decides it, and what was actually found. */
export function driftError(claim: DocClaim, expected: string, found: string): Error {
	return new Error(
		[
			`DOC DRIFT: ${claim.claim}`,
			'',
			`  documented in  : ${claim.shownIn}`,
			`  source of truth: ${claim.decidedBy}`,
			`  expected       : ${expected}`,
			`  found          : ${found}`,
			'',
			'The prose and the implementation disagree. Read the source of truth above, then fix',
			'whichever is wrong: if the code changed, update the docs; if the prose was never true,',
			'this guard is what should have caught it. Do not delete the guard.',
		].join('\n'),
	);
}
