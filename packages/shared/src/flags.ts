// Feature-flag evaluation — the ONE evaluator, imported by the server (/eval), the browser SDK, and the
// dashboard preview, so the three can never diverge. Bucketing is done entirely in the BigInt integer
// domain (u64 % 10000): SHA-256 of the stable inputs → a uniform integer point in [0, 10000). No float
// is ever touched, so a draw is byte-identical across V8/workerd/Node (the naive `hi*2^32+lo` form
// overflows 2^53 and silently double-rounds — a real bug this avoids). One gate — `inRollout` — is used
// for both percentage rollout and `pct` targeting clauses, so a 25% rule and a 2500bp ramp select the
// identical cohort. The bucketing KEY is a caller-supplied stable id (the SDK's `facet.exp`), NEVER the
// daily-rotating visitor hash, so assignments are sticky across UTC-day rotation.

const DELIM = '|';
const encoder = new TextEncoder();

/** A weighted variant. `weight` is basis points (0..10000); the set sums to 10000. */
export interface FlagVariant {
	key: string;
	weight: number;
}

export type FlagOp = 'eq' | 'neq' | 'in' | 'nin' | 'contains' | 'prefix' | 'gte' | 'lte' | 'pct';

/** One AND-clause of a targeting rule. `pct` is a sticky percentage gate over the ramp draw. */
export interface FlagClause {
	attr: string;
	op: FlagOp;
	value: string | number | string[];
}

/** What a matched rule serves: a fixed variant, or a weighted split. */
export type FlagServe = { variant: string } | { rollout: FlagVariant[] };

export interface FlagRule {
	priority: number;
	clauses: FlagClause[];
	serve: FlagServe;
}

/** The bucketing/eval config for one flag — exactly the fields safe to expose to a client bucketer. */
export interface FlagConfig {
	flag_key: string;
	type: 'boolean' | 'multivariate';
	enabled: boolean;
	default_variant: string;
	variants: FlagVariant[];
	salt: string;
	rollout_seed: number;
	version: number;
	rules: FlagRule[];
}

/** The non-sensitive subset shipped by the public `/active` endpoint: everything a client needs to
 * bucket base rollout offline, and nothing more. Targeting `rules` (which can encode business logic
 * and audience attributes) are withheld — targeted evaluation goes through the authenticated `/eval`
 * path where rules stay server-side. */
export type PublicFlag = Omit<FlagConfig, 'rules'>;

/** A stored flag as returned by the admin API: the full eval config plus its identity/metadata. */
export interface FlagRecord extends FlagConfig {
	id: string;
	site_id: string;
	name: string;
	created_at: number;
	updated_at: number;
}

/** Targeting context. All attributes are cookieless; `custom.*` is visitor-asserted (never trust it for
 * entitlement — a caller can set it freely). */
export interface FlagContext {
	country?: string;
	device?: string;
	path?: string;
	host?: string;
	channel?: string;
	lang?: string;
	custom?: Record<string, string | number>;
}

export interface FlagAssignment {
	variant: string;
	participating: boolean;
	reason: string;
}

/** A deterministic, uniform integer draw in [0, 10000) from the stable inputs. BigInt end-to-end: the
 * first 8 SHA-256 bytes form a u64, reduced mod 10000 (mod bias ~10^4/2^64 is negligible). No float. */
export async function bucket(
	stableId: string,
	flagKey: string,
	salt: string,
	seed: number,
	namespace: string,
): Promise<number> {
	const input = [stableId, flagKey, salt, String(seed), namespace].join(DELIM);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
	let u = 0n;
	for (let i = 0; i < 8; i++) u = (u << 8n) | BigInt(digest[i] as number);
	return Number(u % 10000n);
}

/** Whether a ramp draw (0..9999) falls inside a rollout of `rolloutBp` basis points (0..10000). The one
 * gate for both base rollout and `pct` clauses. Monotone: raising `rolloutBp` only widens the interval. */
export function inRollout(point: number, rolloutBp: number): boolean {
	return point < rolloutBp;
}

/** Pick a variant for a draw (0..9999) over a basis-point-weighted set summing to 10000. */
export function pickVariant(point: number, variants: FlagVariant[]): string {
	let acc = 0;
	for (const v of variants) {
		acc += v.weight;
		if (point < acc) return v.key;
	}
	// The top slice [acc, 10000) is served here; unreachable via the loop since point maxes at 9999.
	return variants[variants.length - 1]?.key ?? '';
}

function ctxValue(ctx: FlagContext, attr: string): string | number | undefined {
	if (attr.startsWith('custom.')) return ctx.custom?.[attr.slice('custom.'.length)];
	return (ctx as Record<string, unknown>)[attr] as string | number | undefined;
}

/** Whether every clause matches (AND). `pct` routes through the same `inRollout` gate as base rollout. */
function clausesMatch(clauses: FlagClause[], ctx: FlagContext, rampPoint: number): boolean {
	return clauses.every((c) => {
		if (c.op === 'pct') {
			const pct = typeof c.value === 'number' ? c.value : Number(c.value);
			return inRollout(rampPoint, Math.round(pct * 100));
		}
		const actual = ctxValue(ctx, c.attr);
		if (actual === undefined) return false;
		switch (c.op) {
			case 'eq':
				return actual === c.value;
			case 'neq':
				return actual !== c.value;
			case 'in':
				return Array.isArray(c.value) && c.value.includes(String(actual));
			case 'nin':
				return Array.isArray(c.value) && !c.value.includes(String(actual));
			case 'contains':
				return String(actual).includes(String(c.value));
			case 'prefix':
				return String(actual).startsWith(String(c.value));
			case 'gte':
				return Number(actual) >= Number(c.value);
			case 'lte':
				return Number(actual) <= Number(c.value);
			default:
				return false;
		}
	});
}

/** Evaluate a flag for a visitor: kill switch → first matching rule (by priority) → base rollout. Pure
 * and side-effect-free; exposure logging is the caller's job. */
export async function evaluateFlag(
	flag: FlagConfig,
	ctx: FlagContext,
	stableId: string,
): Promise<FlagAssignment> {
	if (!flag.enabled) {
		return {
			variant: flag.default_variant,
			participating: false,
			reason: 'disabled',
		};
	}
	const [rampPoint, variantPoint] = await Promise.all([
		bucket(stableId, flag.flag_key, flag.salt, flag.rollout_seed, 'ramp'),
		bucket(stableId, flag.flag_key, flag.salt, flag.rollout_seed, 'variant'),
	]);
	const rules = [...flag.rules].sort((a, b) => a.priority - b.priority);
	for (const rule of rules) {
		if (clausesMatch(rule.clauses, ctx, rampPoint)) {
			return 'variant' in rule.serve
				? {
						variant: rule.serve.variant,
						participating: true,
						reason: `rule:${rule.priority}`,
					}
				: {
						variant: pickVariant(variantPoint, rule.serve.rollout),
						participating: true,
						reason: `rule:${rule.priority}`,
					};
		}
	}
	return {
		variant: pickVariant(variantPoint, flag.variants),
		participating: true,
		reason: 'rollout',
	};
}
