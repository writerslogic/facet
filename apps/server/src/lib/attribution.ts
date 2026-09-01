// Multi-touch attribution over aggregate, day-scoped channel paths — NO persistent cross-session
// identity. Each `AttributionPath` is one visitor's ordered channel touches within a UTC day (consecutive
// duplicates collapsed), flagged `converted` with the day's revenue `value`. Five heuristic models plus
// the data-driven `markov` removal-effect distribute each converting path's revenue across its channels.

import type { AttributionModel, AttributionResult, CountRow } from '@facet/shared';

/** One visitor's within-day channel path: ordered channels, whether it converted, and its revenue. */
export interface AttributionPath {
	channels: string[];
	value: number;
	converted: boolean;
}

const MODELS: AttributionModel[] = ['first', 'last', 'linear', 'position', 'time_decay', 'markov'];

/** Collapse consecutive duplicate channels (standard attribution normalization). */
function collapse(channels: string[]): string[] {
	return channels.filter((c, i) => i === 0 || c !== channels[i - 1]);
}

/** Compute per-model channel credit (revenue-weighted) from a set of paths. */
export function computeAttribution(rawPaths: AttributionPath[]): AttributionResult {
	const paths = rawPaths
		.map((p) => ({
			channels: collapse(p.channels),
			value: p.value,
			// IMPORTANT: one definition of "converted" for every model. The markov chain reads this
			// same flag, so a zero-revenue path must not be an absorbing `conv` while being absent
			// from `conversions`/`revenue`.
			converted: p.converted && p.value > 0,
		}))
		.filter((p) => p.channels.length > 0);
	const converting = paths.filter((p) => p.converted);
	const conversions = converting.length;
	const revenue = converting.reduce((s, p) => s + p.value, 0);

	const credit: Record<AttributionModel, Map<string, number>> = {
		first: new Map(),
		last: new Map(),
		linear: new Map(),
		position: new Map(),
		time_decay: new Map(),
		markov: new Map(),
	};
	const add = (m: AttributionModel, ch: string, v: number): void => {
		credit[m].set(ch, (credit[m].get(ch) ?? 0) + v);
	};

	for (const p of converting) {
		const c = p.channels;
		const n = c.length;
		const V = p.value;
		add('first', c[0] as string, V);
		add('last', c[n - 1] as string, V);
		for (const ch of c) add('linear', ch, V / n);
		// Position (U-shaped): 40% first, 40% last, 20% split across the middle.
		if (n === 1) {
			add('position', c[0] as string, V);
		} else if (n === 2) {
			add('position', c[0] as string, V * 0.5);
			add('position', c[1] as string, V * 0.5);
		} else {
			add('position', c[0] as string, V * 0.4);
			add('position', c[n - 1] as string, V * 0.4);
			const mid = (V * 0.2) / (n - 2);
			for (let i = 1; i < n - 1; i++) add('position', c[i] as string, mid);
		}
		// Time decay: later touches weigh more (geometric, doubling per step).
		// IMPORTANT: exponents are anchored on the last touch. `2 ** i` overflowed to Infinity past
		// 1024 touches, making wsum Infinity and every credit NaN; anchored, early touches underflow
		// to 0 instead. The normalized weights are identical.
		const weights = c.map((_, i) => 2 ** (i - (n - 1)));
		const wsum = weights.reduce((a, b) => a + b, 0);
		c.forEach((ch, i) => add('time_decay', ch, (V * (weights[i] as number)) / wsum));
	}

	markov(paths, revenue, (ch, v) => add('markov', ch, v));

	const toRows = (m: Map<string, number>): CountRow[] =>
		[...m.entries()]
			.map(([key, v]) => ({ key, count: Math.round(v) }))
			.sort((a, b) => b.count - a.count);
	return {
		conversions,
		revenue,
		models: Object.fromEntries(MODELS.map((m) => [m, toRows(credit[m])])) as Record<
			AttributionModel,
			CountRow[]
		>,
	};
}

/** Data-driven Markov removal-effect: build the channel-transition chain over ALL paths (converting and
 * not), estimate the base conversion probability, then credit each channel by how much removing it drops
 * that probability — distributing total revenue by the normalized removal effects. */
function markov(
	paths: { channels: string[]; converted: boolean }[],
	totalRevenue: number,
	add: (ch: string, v: number) => void,
): void {
	if (totalRevenue <= 0) return;
	const trans = new Map<string, Map<string, number>>();
	const channels = new Set<string>();
	const bump = (from: string, to: string): void => {
		let m = trans.get(from);
		if (!m) {
			m = new Map();
			trans.set(from, m);
		}
		m.set(to, (m.get(to) ?? 0) + 1);
	};
	for (const p of paths) {
		const c = p.channels;
		for (const ch of c) channels.add(ch);
		bump('start', c[0] as string);
		for (let i = 0; i < c.length - 1; i++) bump(c[i] as string, c[i + 1] as string);
		bump(c[c.length - 1] as string, p.converted ? 'conv' : 'null');
	}
	if (channels.size === 0) return;
	// Row-normalize transition counts into probabilities.
	const prob = new Map<string, Map<string, number>>();
	for (const [from, m] of trans) {
		const total = [...m.values()].reduce((a, b) => a + b, 0);
		const pm = new Map<string, number>();
		for (const [to, ct] of m) pm.set(to, ct / total);
		prob.set(from, pm);
	}
	const states = ['start', ...channels];
	// Value-iterate the conversion probability from each transient state (conv=1, null=0). `removed`
	// pins a channel to 0 (and severs transitions into it), giving the removal-effect scenario.
	const conversionProb = (removed: string | null): number => {
		const P = new Map<string, number>([
			['conv', 1],
			['null', 0],
		]);
		for (const s of states) P.set(s, 0);
		for (let iter = 0; iter < 200; iter++) {
			let maxDelta = 0;
			for (const s of states) {
				if (s === removed) continue;
				const pm = prob.get(s);
				if (!pm) continue;
				let v = 0;
				for (const [to, pr] of pm) v += pr * (to === removed ? 0 : (P.get(to) ?? 0));
				maxDelta = Math.max(maxDelta, Math.abs(v - (P.get(s) ?? 0)));
				P.set(s, v);
			}
			if (maxDelta < 1e-9) break;
		}
		return P.get('start') ?? 0;
	};
	const base = conversionProb(null);
	if (base <= 0) return;
	const removal = new Map<string, number>();
	let totalRE = 0;
	for (const ch of channels) {
		const re = Math.max(0, base - conversionProb(ch));
		removal.set(ch, re);
		totalRE += re;
	}
	if (totalRE <= 0) {
		const each = totalRevenue / channels.size;
		for (const ch of channels) add(ch, each);
		return;
	}
	for (const ch of channels) add(ch, (totalRevenue * (removal.get(ch) as number)) / totalRE);
}
