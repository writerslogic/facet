// Fabricated dataset for the public static demo. NOTHING here is real: it's a fictional site
// ("Aperture Store") with deterministic, plausible traffic so the demo looks alive without any
// backend and without exposing any real analytics. The dimensional cube is generated first and the
// rest of the stats response is DERIVED from it, so KPIs, the chart, breakdowns, and cross-filtering
// all agree. Buckets are anchored to the request time, so the demo always looks current.

import type {
	AnomaliesResponse,
	ApiKeyRecord,
	AttributionModel,
	AttributionResult,
	BreakdownDimension,
	BreakdownResponse,
	ClockCell,
	ClockResponse,
	CohortPeriod,
	CohortRetentionResponse,
	CountRow,
	CubeCell,
	CubeResponse,
	DimensionSeries,
	DimensionSeriesPoint,
	DimensionSeriesResponse,
	DistributionBucket,
	DistributionPercentile,
	Experiment,
	ExperimentResult,
	Funnel,
	FunnelReportResult,
	Goal,
	GoalConversionResult,
	Interval,
	JourneyPair,
	JourneysResponse,
	MetricDistribution,
	NlQueryResult,
	PathTreeNode,
	PathTreeResponse,
	QueryIntent,
	RealtimeSnapshot,
	SeriesDimension,
	SessionDistributionResponse,
	Site,
	StatsResponse,
	TimelineAnnotationsResponse,
} from '@facet/shared';
import { DEMO_SITE_ID } from './constants.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The literal the real cube folds every non-top country into. Not an ISO code, by design. */
const CUBE_OTHER = 'other';

/**
 * The interval the real API picks when the caller does not name one (see `/api/stats`). Mirrored so a
 * range the dashboard sends without `interval` buckets the same way here as it would server-side.
 */
export function defaultInterval(start: number, end: number): Interval {
	return end - start <= 48 * HOUR_MS ? 'hour' : 'day';
}

/** Deterministic 32-bit PRNG (mulberry32) so the demo is stable across reloads for a given bucket. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function hash(...nums: number[]): number {
	let h = 2_166_136_261;
	for (const n of nums) {
		h ^= n | 0;
		h = Math.imul(h, 16_777_619);
	}
	return h >>> 0;
}

interface Dim {
	key: string;
	weight: number;
}

const DEVICES: Dim[] = [
	{ key: 'desktop', weight: 0.57 },
	{ key: 'mobile', weight: 0.37 },
	{ key: 'tablet', weight: 0.06 },
];

/**
 * ISO A2 codes, NOT display names. The real API stores `request.cf.country` uppercased (see
 * `request-meta.ts`: `XX`/`T1` become null and are excluded), so `top_countries` and the cube's
 * `country` axis are both ISO codes — which is what `WorldMap` looks up against the world geometry
 * (`r.key.toUpperCase()`) and what the country top-list sizes its leading column for. Display names
 * here meant the demo's choropleth matched nothing and rendered as an unlit outline.
 *
 * `other` is the cube's fold bucket for everything outside the top countries, exactly as the real
 * cube emits it; the raw-column `top_countries` breakdown never contains it.
 */
const COUNTRIES: Dim[] = [
	{ key: 'US', weight: 0.33 },
	{ key: 'IN', weight: 0.11 },
	{ key: 'DE', weight: 0.09 },
	{ key: 'GB', weight: 0.08 },
	{ key: 'FR', weight: 0.06 },
	{ key: 'CA', weight: 0.05 },
	{ key: 'BR', weight: 0.05 },
	{ key: CUBE_OTHER, weight: 0.23 },
];

const CHANNELS: Dim[] = [
	{ key: 'direct', weight: 0.34 },
	{ key: 'organic', weight: 0.28 },
	{ key: 'referral', weight: 0.16 },
	{ key: 'social', weight: 0.12 },
	{ key: 'paid', weight: 0.06 },
	{ key: 'email', weight: 0.04 },
];

/** Diurnal shape (0..1) by UTC hour — quiet overnight, twin daytime peaks. */
function diurnal(hourOfDay: number): number {
	return (
		0.45 +
		0.4 * Math.sin(((hourOfDay - 8) / 24) * 2 * Math.PI) +
		(hourOfDay >= 13 && hourOfDay <= 21 ? 0.2 : 0)
	);
}

/** Weekly shape (0..1) — weekdays busier than weekends. */
function weekly(dayOfWeek: number): number {
	return dayOfWeek === 0 || dayOfWeek === 6 ? 0.72 : 1;
}

/** Total pageviews for one bucket, before splitting across dimensions. */
function bucketVolume(t: number, interval: Interval): number {
	const d = new Date(t);
	const jitter = 0.85 + rng(hash(t, 7))() * 0.3;
	const perDay = 11_500 * weekly(d.getUTCDay());
	if (interval === 'hour') {
		return Math.max(1, Math.round((perDay / 24) * diurnal(d.getUTCHours()) * jitter));
	}
	return Math.max(1, Math.round(perDay * jitter));
}

/** Snap a timestamp down to the start of its bucket. */
function floorBucket(t: number, bucketMs: number): number {
	return Math.floor(t / bucketMs) * bucketMs;
}

/** Generate the dimensional cube for a range. This is the single source of truth the stats response
 * is derived from. */
export function buildCube(start: number, end: number, interval: Interval): CubeResponse {
	const bucketMs = interval === 'hour' ? HOUR_MS : DAY_MS;
	const cells: CubeCell[] = [];
	const first = floorBucket(start, bucketMs);
	for (let t = first; t < end; t += bucketMs) {
		const total = bucketVolume(t, interval);
		for (const dev of DEVICES) {
			for (const country of COUNTRIES) {
				for (const ch of CHANNELS) {
					const share = dev.weight * country.weight * ch.weight;
					const r = rng(
						hash(t, dev.key.length * 31, country.key.length * 7, ch.key.length),
					);
					const pageviews = Math.round(total * share * (0.8 + r() * 0.4));
					if (pageviews <= 0) continue;
					cells.push({
						t,
						device: dev.key,
						country: country.key,
						channel: ch.key,
						pageviews,
						events: Math.round(pageviews * (1.12 + r() * 0.22)),
						visitors: Math.max(1, Math.round(pageviews * (0.52 + r() * 0.12))),
					});
				}
			}
		}
	}
	return { interval, cells };
}

/** Sum a cube dimension into a sorted CountRow breakdown. */
function breakdown(cells: CubeCell[], dim: 'device' | 'country' | 'channel'): CountRow[] {
	const m = new Map<string, number>();
	for (const c of cells) m.set(c[dim], (m.get(c[dim]) ?? 0) + c.pageviews);
	return [...m.entries()]
		.map(([key, count]) => ({ key, count }))
		.sort((a, b) => b.count - a.count);
}

/** Distribute `total` over a fixed list of labels as a geometric decay (ratio `decay`, 0..1), so the
 * result is always non-increasing and sums to roughly `total` — a realistic long-tail top-list. */
function scaled(labels: string[], total: number, decay: number): CountRow[] {
	const weights = labels.map((_, i) => decay ** i);
	const wsum = weights.reduce((a, b) => a + b, 0);
	return labels.map((key, i) => ({
		key,
		count: Math.max(1, Math.round((total * (weights[i] ?? 0)) / wsum)),
	}));
}

// The real `channels()` groups the raw `event_sessions.channel` column, whose values are the
// `Channel` union ('direct' | 'organic' | …) — so channel keys stay lowercase and raw everywhere,
// matching the cube's `channel` axis. Presentational labels were a demo-only invention: they made
// `channels` disagree with `cubeBreakdown('channel')`, and a click on a channel row filtered the cube
// by a key ('Organic search') that no cell could ever carry.

/**
 * The exact-match dimension filters `/api/stats` accepts (`StatsQuerySchema`). `country`, `device`
 * and `channel` are cube axes and are applied by dropping cells; `path` and `referrer` are
 * high-cardinality and live outside the cube, so they scale the whole response by that row's share
 * and collapse their own breakdown to the matched row — the same narrowing the real
 * `buildFilteredEventWhere` produces.
 */
export interface DemoStatsFilter {
	path?: string;
	referrer?: string;
	country?: string;
	device?: string;
	channel?: string;
}

/** A row's share of its list's total, or 0 when the key is absent (the real filter would match none). */
function shareOf(rows: CountRow[], key: string): number {
	const total = rows.reduce((s, r) => s + r.count, 0);
	const row = rows.find((r) => r.key === key);
	return total > 0 && row ? row.count / total : 0;
}

function scaleRows(rows: CountRow[], factor: number): CountRow[] {
	return rows.map((r) => ({ key: r.key, count: Math.round(r.count * factor) }));
}

/** Build the full stats response for a range, derived from the cube so every number is consistent. */
export function buildStats(
	start: number,
	end: number,
	interval: Interval,
	filter: DemoStatsFilter = {},
): StatsResponse {
	const base = buildRangeStats(start, end, interval, filter);
	if (!filter.path && !filter.referrer) return base;

	// One high-cardinality filter at a time is all the Overview ever sends; when both are present the
	// shares compose, exactly as two ANDed WHERE clauses would narrow the real query.
	const pathShare = filter.path ? shareOf(base.top_paths, filter.path) : 1;
	const referrerShare = filter.referrer ? shareOf(base.top_referrers, filter.referrer) : 1;
	const factor = pathShare * referrerShare;

	return {
		...base,
		summary: {
			pageviews: Math.round(base.summary.pageviews * factor),
			visitors: Math.round(base.summary.visitors * factor),
			events: Math.round(base.summary.events * factor),
		},
		series: base.series.map((p) => ({
			t: p.t,
			pageviews: Math.round(p.pageviews * factor),
			visitors: Math.round(p.visitors * factor),
		})),
		top_paths: filter.path
			? base.top_paths.filter((r) => r.key === filter.path)
			: scaleRows(base.top_paths, factor),
		top_referrers: filter.referrer
			? base.top_referrers.filter((r) => r.key === filter.referrer)
			: scaleRows(base.top_referrers, factor),
		top_events: scaleRows(base.top_events, factor),
		top_countries: scaleRows(base.top_countries, factor),
		top_devices: scaleRows(base.top_devices, factor),
		channels: scaleRows(base.channels, factor),
		engagement: {
			...base.engagement,
			sessions: Math.round(base.engagement.sessions * factor),
		},
	};
}

function buildRangeStats(
	start: number,
	end: number,
	interval: Interval,
	filter: DemoStatsFilter,
): StatsResponse {
	const all = buildCube(start, end, interval).cells;
	// Cube-axis filters are exact-match on the cell, so they narrow every derived number at once.
	const cells = all.filter(
		(c) =>
			(filter.country === undefined || c.country === filter.country) &&
			(filter.device === undefined || c.device === filter.device) &&
			(filter.channel === undefined || c.channel === filter.channel),
	);
	const pageviews = cells.reduce((s, c) => s + c.pageviews, 0);
	const events = cells.reduce((s, c) => s + c.events, 0);
	// Distinct visitors is NOT the sum of per-cell visitors (that over-counts); use a site-wide factor.
	const visitors = Math.round(pageviews * 0.41);

	const seriesMap = new Map<number, number>();
	for (const c of cells) seriesMap.set(c.t, (seriesMap.get(c.t) ?? 0) + c.pageviews);
	const series = [...seriesMap.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([t, pv]) => ({
			t,
			pageviews: pv,
			visitors: Math.round(pv * 0.48),
		}));

	const channels = breakdown(cells, 'channel');

	// Revenue and attribution are filtered reads upstream too, so they may only credit channels that
	// survived the filter — crediting all six under `channel=social` would contradict the breakdown
	// right next to them.
	const present = CHANNELS.filter((c) => channels.some((row) => row.key === c.key));
	const orders = Math.max(1, Math.round(visitors * 0.031));
	const aov = 68.4;
	const revenueTotal = Math.round(orders * aov * 100) / 100;
	const revenueByChannel = present
		.map((c) => ({
			key: c.key,
			count: Math.round(revenueTotal * c.weight),
		}))
		.sort((a, b) => b.count - a.count);

	const models = ['first', 'last', 'linear', 'position', 'time_decay', 'markov'] as const;
	const attribution: AttributionResult = {
		conversions: orders,
		revenue: revenueTotal,
		models: Object.fromEntries(
			models.map((m, i) => [
				m,
				present
					.map((c, j) => ({
						key: c.key,
						// Vary credit slightly per model so the model switch is visibly meaningful.
						count: Math.round(revenueTotal * c.weight * (0.7 + ((i + j) % 5) * 0.12)),
					}))
					.sort((a, b) => b.count - a.count),
			]),
		) as Record<AttributionModel, CountRow[]>,
	};

	return {
		summary: { pageviews, visitors, events },
		series,
		// Deliberately nested under shared prefixes: the path tree and the sunburst are only meaningful
		// when siblings actually roll up, and a flat list of top-level pages would have demoed a
		// hierarchy with no hierarchy in it.
		top_paths: scaled(
			[
				'/',
				'/pricing',
				'/features',
				'/blog/launch',
				'/docs/getting-started',
				'/blog/changelog-2026',
				'/docs/api/stats',
				'/docs/api/collect',
				'/blog/hiring',
				'/about',
				'/signup',
			],
			pageviews,
			0.28,
		),
		top_referrers: scaled(
			[
				'google.com',
				'github.com',
				'news.ycombinator.com',
				'reddit.com',
				't.co',
				'duckduckgo.com',
				'bing.com',
			],
			Math.round(pageviews * 0.46),
			0.3,
		),
		top_events: scaled(
			['pageview', 'signup', 'add_to_cart', 'checkout', 'download', 'share', 'search'],
			events,
			0.62,
		),
		// The raw-column breakdown, so the cube's `other` fold bucket is excluded — the real
		// `topCountries` groups `events.country` directly and can only ever return ISO codes.
		top_countries: breakdown(cells, 'country').filter((r) => r.key !== CUBE_OTHER),
		top_devices: breakdown(cells, 'device'),
		engagement: {
			sessions: Math.round(visitors * 1.28),
			bounce_rate: 0.41,
			pages_per_session: 2.7,
			avg_duration_ms: 138_000,
		},
		channels,
		top_browsers: scaled(
			['Chrome', 'Safari', 'Edge', 'Firefox', 'Samsung Internet', 'Opera'],
			visitors,
			0.52,
		),
		top_os: scaled(['Windows', 'macOS', 'iOS', 'Android', 'Linux', 'ChromeOS'], visitors, 0.4),
		// IMPORTANT: these are the collector's own allowlisted values, not plausible-looking ones. The
		// demo is the public argument for the privacy claim, so it must never display a dimension at a
		// finer grain than the product can store: screen is a width TIER bucketed on-device
		// (request-meta.ts SCREEN_TIERS), connection an RTT tier, and language the primary subtag only,
		// because the full Accept-Language list is a strong fingerprint. Exact resolutions and region
		// subtags here advertised data facet deliberately refuses to collect.
		top_screens: scaled(['phone', 'laptop', 'desktop', 'tablet', 'ultrawide'], visitors, 0.34),
		top_languages: scaled(['en', 'de', 'fr', 'es', 'pt', 'ja'], visitors, 0.48),
		top_regions: scaled(
			['California', 'Texas', 'New York', 'Maharashtra', 'Bavaria', 'Île-de-France'],
			visitors,
			0.3,
		),
		top_networks: scaled(
			['Comcast', 'Jio', 'Deutsche Telekom', 'AT&T', 'Vodafone', 'Orange'],
			visitors,
			0.28,
		),
		top_connections: scaled(['fast', 'moderate', 'slow'], visitors, 0.44),
		revenue: { total: revenueTotal, orders, aov, currency: 'USD' },
		revenue_by_channel: revenueByChannel,
		attribution,
		meta: { materialization: 'hourly', pending: false },
	};
}

export const DEMO_SITE: Site = {
	id: DEMO_SITE_ID,
	name: 'Aperture Store (demo)',
	domain: 'demo.facet.dev',
	created_at: Date.UTC(2025, 0, 6),
};

export const DEMO_KEYS: ApiKeyRecord[] = [
	{
		id: '00000000-0000-4000-8000-0000000000a1',
		site_id: DEMO_SITE_ID,
		label: 'reporting (read-only demo)',
		created_at: Date.UTC(2025, 0, 6),
		last_used: Date.now(),
		scopes: ['read'],
	},
];

export function buildRealtime(): RealtimeSnapshot {
	const now = Date.now();
	const r = rng(hash(Math.floor(now / 60_000)));
	return {
		window_ms: 5 * 60_000,
		visitors: 40 + Math.round(r() * 90),
		pageviews: 120 + Math.round(r() * 260),
		until: now,
	};
}

/**
 * The real detector scans the hourly series WITHIN the requested range, so an anomaly it reports is
 * always inside that range — a window that ends before the spike returns nothing. Anchoring to
 * `Date.now()` instead put a marker outside the queried window on the demo's traffic chart.
 */
export function buildAnomalies(start: number, end: number): AnomaliesResponse {
	const bucket = floorBucket(end, HOUR_MS) - HOUR_MS;
	if (bucket < start) return { anomalies: [] };
	const baseline = bucketVolume(bucket, 'hour');
	const value = Math.round(baseline * 1.96);
	return {
		anomalies: [
			{
				metric: 'pageviews',
				bucket,
				value,
				baseline_mean: baseline,
				z: 3.4,
				direction: 'spike',
				diagnosis: {
					dimension: 'channel',
					value: 'social',
					current: Math.round(value * 0.39),
					baseline_avg: Math.round(baseline * 0.12),
				},
				summary:
					'Pageviews spiked ~2× above the hourly baseline, driven mostly by social referrals.',
			},
		],
	};
}

/** Fictional operator context for the demo chart, range-filtered exactly like the D1 endpoint. */
export function buildTimelineAnnotations(start: number, end: number): TimelineAnnotationsResponse {
	const candidates: TimelineAnnotationsResponse['annotations'] = [
		{
			id: 'demo-annotation-release',
			site_id: DEMO_SITE_ID,
			label: 'Released the redesigned product page',
			category: 'release',
			occurred_at: end - 5 * DAY_MS,
			created_at: end - 5 * DAY_MS + HOUR_MS,
		},
		{
			id: 'demo-annotation-campaign',
			site_id: DEMO_SITE_ID,
			label: 'Newsletter campaign launched',
			category: 'campaign',
			occurred_at: end - 2 * DAY_MS,
			created_at: end - 2 * DAY_MS + HOUR_MS,
		},
	];
	return {
		annotations: candidates.filter(
			(annotation) => annotation.occurred_at >= start && annotation.occurred_at < end,
		),
	};
}

/**
 * Cohorts are grouped by the period of first activity WITHIN the range, so both how many cohorts
 * there are and where they sit follow the window — a 7-day window cannot contain six weekly cohorts,
 * and none of them may start after `end`.
 */
export function buildRetention(
	period: CohortPeriod,
	start: number,
	end: number,
): CohortRetentionResponse {
	const periodMs = (period === 'week' ? 7 : 1) * DAY_MS;
	const cap = period === 'week' ? 6 : 8;
	const periods = Math.max(1, Math.min(cap, Math.floor((end - start) / periodMs)));
	const cohorts = Array.from({ length: periods }, (_, i) => {
		const day = new Date(end - (periods - i) * periodMs);
		const r = rng(hash(day.getUTCDate(), i));
		const size = 400 + Math.round(r() * 700);
		const retention = Array.from({ length: periods - i }, (_, n) =>
			n === 0 ? 1 : Math.max(0.04, 0.5 * Math.exp(-n * 0.55) + r() * 0.04),
		);
		return { cohort: day.toISOString().slice(0, 10), size, retention };
	});
	return {
		period,
		cohorts,
		note: 'Visitor hashes rotate daily for privacy, so cross-day retention is a lower bound (see docs/privacy).',
	};
}

export const DEMO_GOALS: Goal[] = [
	{
		id: 'g1',
		site_id: DEMO_SITE_ID,
		name: 'Signup',
		type: 'event',
		match_value: 'signup',
		created_at: Date.UTC(2025, 0, 6),
	},
	{
		id: 'g2',
		site_id: DEMO_SITE_ID,
		name: 'Checkout',
		type: 'event',
		match_value: 'checkout',
		created_at: Date.UTC(2025, 0, 6),
	},
];

export const DEMO_FUNNELS: Funnel[] = [
	{
		id: 'f1',
		site_id: DEMO_SITE_ID,
		name: 'Purchase',
		steps: [
			{ type: 'path', match_value: '/' },
			{ type: 'path', match_value: '/pricing' },
			{ type: 'event', match_value: 'add_to_cart' },
			{ type: 'event', match_value: 'checkout' },
		],
		created_at: Date.UTC(2025, 0, 6),
	},
];

/**
 * Every count the real API derives from events is bounded by the queried window, so the fixtures
 * below scale off the window's own session total rather than sitting at a constant. A wider window
 * must move the numbers; that is the property the demo exists to demonstrate.
 */
function sessionsIn(start: number, end: number): number {
	return buildStats(start, end, defaultInterval(start, end)).engagement.sessions;
}

export function buildFunnelReport(start: number, end: number): FunnelReportResult {
	const entered = Math.max(1, Math.round(sessionsIn(start, end) * 0.36));
	const retention = [1, 0.418, 0.181, 0.078];
	const labels = ['/', '/pricing', 'add_to_cart', 'checkout'];
	const steps = labels.map((matchValue, index) => ({
		index,
		match_value: matchValue,
		count: Math.max(1, Math.round(entered * (retention[index] ?? 0))),
	}));
	const first = steps[0]?.count ?? 1;
	const last = steps[steps.length - 1]?.count ?? 0;
	return { steps, overall_rate: last / first };
}

export function buildConversions(goalId: string, start: number, end: number): GoalConversionResult {
	const sessions = sessionsIn(start, end);
	const conversions = Math.max(1, Math.round(sessions * (goalId === 'g2' ? 0.028 : 0.075)));
	return {
		goal_id: goalId,
		conversions,
		sessions,
		rate: conversions / sessions,
	};
}

export const DEMO_EXPERIMENTS: Experiment[] = [
	{
		id: 'e1',
		site_id: DEMO_SITE_ID,
		name: 'Pricing page CTA',
		flag_key: 'pricing_cta',
		variants: [
			{ key: 'control', weight: 1 },
			{ key: 'urgency', weight: 1 },
		],
		active: true,
		created_at: Date.UTC(2025, 1, 1),
	},
];

export function buildExperimentResult(start: number, end: number): ExperimentResult {
	// Exposures accrue over the window, so a wider window means a bigger sample — and the demo's
	// significance verdict is only honest if it moves with it.
	const exposures = Math.max(1, Math.round(sessionsIn(start, end) * 0.24));
	return {
		variants: [
			{
				key: 'control',
				exposures,
				conversions: Math.max(1, Math.round(exposures * 0.05)),
				rate: 0.05,
				p_value: null,
				significant: false,
			},
			{
				key: 'urgency',
				exposures: Math.max(1, exposures - 30),
				conversions: Math.max(1, Math.round(exposures * 0.061)),
				rate: 0.061,
				p_value: 0.017,
				significant: true,
			},
		],
	};
}

export function buildInteractions(start: number, end: number): { interactions: CountRow[] } {
	const stats = buildStats(start, end, defaultInterval(start, end));
	return {
		interactions: scaled(
			['click', 'scroll_75', 'form_submit', 'copy', 'outbound_click', 'video_play'],
			Math.round(stats.summary.events * 0.42),
			0.4,
		),
	};
}

/**
 * Stand-in for the model's `QueryIntent`. The real endpoint sends the question to Workers AI, which
 * emits ONLY an intent from a closed vocabulary that the server then executes over the same aggregate
 * helpers every other tab uses. The demo has no model, so a keyword match picks the intent — but the
 * execution below must stay faithful, because the intent is the part the Ask panel displays and
 * reasons about (`looksLikeFallbackIntent`). Falls back to the same bare `{ metric: 'pageviews' }`
 * the server falls back to when the model's output fails to validate.
 */
function guessIntent(question: string): QueryIntent {
	const q = question.toLowerCase();
	const metric: QueryIntent['metric'] = q.includes('bounce')
		? 'bounce_rate'
		: q.includes('session')
			? 'sessions'
			: q.includes('event')
				? 'events'
				: q.includes('visitor') || q.includes('people') || q.includes('audience')
					? 'visitors'
					: 'pageviews';
	const dimension: QueryIntent['dimension'] =
		q.includes('page') && q.includes('top')
			? 'path'
			: q.includes('referr') || q.includes('source')
				? 'referrer'
				: q.includes('countr') || q.includes('where')
					? 'country'
					: q.includes('device') || q.includes('mobile')
						? 'device'
						: q.includes('channel')
							? 'channel'
							: undefined;
	if (dimension) return { metric, dimension, limit: 5 };
	if (q.includes('trend') || q.includes('over time') || q.includes('by day')) {
		return { metric, series: true };
	}
	return { metric };
}

const percentFormat = new Intl.NumberFormat('en-US', {
	style: 'percent',
	maximumFractionDigits: 1,
});

/**
 * Execute an intent over the window, mirroring the server's `runQueryIntent` — same three result
 * kinds, same answer templates, same aggregate sources. Ignoring `start`/`end` here made the Ask
 * tab's answer-window chips inert: every window returned one frozen fixture, so the demo asserted
 * that the window does not matter, which is the opposite of what the feature does.
 */
export function buildNlQuery(question: string, start: number, end: number): NlQueryResult {
	const intent = guessIntent(question);
	const stats = buildStats(start, end, intent.interval ?? defaultInterval(start, end));

	if (intent.series && !intent.dimension) {
		return {
			intent,
			answer: `Trend of ${intent.metric} over time (${defaultInterval(start, end)})`,
			result: { kind: 'series', points: stats.series },
		};
	}

	if (intent.dimension) {
		const source: Record<NonNullable<QueryIntent['dimension']>, CountRow[]> = {
			path: stats.top_paths,
			referrer: stats.top_referrers,
			country: stats.top_countries,
			device: stats.top_devices,
			channel: stats.channels,
		};
		const rows = (source[intent.dimension] ?? []).slice(0, intent.limit ?? 10);
		const top = rows
			.slice(0, 3)
			.map((r) => `${r.key} (${r.count})`)
			.join(', ');
		return {
			intent,
			answer: `Top ${intent.dimension} by ${intent.metric}: ${top || 'no data'}`,
			result: { kind: 'breakdown', rows },
		};
	}

	const value =
		intent.metric === 'sessions'
			? stats.engagement.sessions
			: intent.metric === 'bounce_rate'
				? stats.engagement.bounce_rate
				: stats.summary[intent.metric];
	const shown = intent.metric === 'bounce_rate' ? percentFormat.format(value) : String(value);
	return {
		intent,
		answer: `${intent.metric}: ${shown}`,
		result: { kind: 'scalar', value },
	};
}

// ── Visualization endpoints ───────────────────────────────────────────────────────────────────────
// The five reads behind the distribution, multi-line, treemap/sunburst, chord and nightingale
// charts. Each mirrors its server contract exactly — same bounds, same anonymity floors, same
// percentile rule — because the demo is the one build with no server to check against.

/** Mirrors `K_ANON_DISTRIBUTION`: below this many sessions the real API emits no statistics at all. */
const DEMO_MIN_DISTRIBUTION = 25;

/** Mirrors `K_ANON`: the floor a labelled tree node or a journey pair must clear upstream. */
const DEMO_K_ANON = 3;

/** Mirrors `PATH_TREE_MAX_DEPTH` / `PATH_TREE_MAX_CHILDREN`. */
const DEMO_TREE_MAX_DEPTH = 4;
const DEMO_TREE_MAX_CHILDREN = 12;

/** Mirrors `JOURNEY_MAX_PAIRS`. */
const DEMO_MAX_PAIRS = 50;

/** Mirrors `SERIES_MAX_KEYS` / `SERIES_DEFAULT_KEYS`. */
export const DEMO_SERIES_MAX_KEYS = 8;
export const DEMO_SERIES_DEFAULT_KEYS = 5;

const DURATION_EDGES = [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];
const PAGE_EDGES = [1, 2, 3, 4, 5, 6, 11, 21];
const PERCENTILE_LEVELS: [DistributionPercentile, number][] = [
	['p05', 0.05],
	['p10', 0.1],
	['p25', 0.25],
	['p50', 0.5],
	['p75', 0.75],
	['p90', 0.9],
	['p95', 0.95],
	['p99', 0.99],
];

/** The server's `nearest-rank-lower` rule: index `floor(p * (n - 1))` of the ascending sample. Not
 * an interpolated quartile — a demo that interpolated would teach a reader the wrong contract. */
function percentileLower(sorted: number[], p: number): number {
	return sorted[Math.floor(p * (sorted.length - 1))] ?? 0;
}

/** `[from, to)` edges for a histogram, matching `bucketRanges` on the server. */
function demoBucketRanges(edges: number[]): { from: number; to: number | null }[] {
	const ranges: { from: number; to: number | null }[] = [{ from: 0, to: edges[0] ?? null }];
	for (let i = 1; i < edges.length; i++) {
		ranges.push({ from: edges[i - 1] as number, to: edges[i] as number });
	}
	ranges.push({ from: edges[edges.length - 1] as number, to: null });
	return ranges;
}

/** How many synthetic sessions are drawn to shape a distribution. The real endpoint scans every
 * session in the range; drawing hundreds of thousands in the browser would freeze the demo, so a
 * bounded sample sets the SHAPE and the histogram is then scaled to the window's real session count. */
const DEMO_SAMPLE = 999;

/** A deterministic, plausibly heavy-tailed session sample for one window: a third of visits bounce
 * at zero duration, the rest decay exponentially. Seeded by the window, so a 7-day and a 30-day
 * query genuinely differ rather than returning one frozen fixture. */
function drawSessionSample(start: number, end: number): { durations: number[]; pages: number[] } {
	const r = rng(hash(start, end, 0x5ed1));
	const durations: number[] = [];
	const pages: number[] = [];
	for (let i = 0; i < DEMO_SAMPLE; i++) {
		const u = r();
		if (u < 0.34) {
			durations.push(0);
			pages.push(r() < 0.85 ? 1 : 0);
			continue;
		}
		// Exponential with a ~150s mean, clipped to the 30-minute session timeout.
		durations.push(Math.min(1_799_000, Math.round(-Math.log(1 - r()) * 150_000)));
		pages.push(2 + Math.floor(-Math.log(1 - r()) * 3.2));
	}
	return { durations: durations.sort((a, b) => a - b), pages: pages.sort((a, b) => a - b) };
}

/** Bin a sample, then scale the bins to `count` so they still sum to it exactly (the invariant the
 * real histogram has by construction). The rounding remainder lands on the largest bin. */
function scaledHistogram(sorted: number[], edges: number[], count: number): DistributionBucket[] {
	const ranges = demoBucketRanges(edges);
	const raw = ranges.map(
		(range) =>
			sorted.filter((v) => v >= range.from && (range.to === null || v < range.to)).length,
	);
	const counts = raw.map((n) => Math.round((n / sorted.length) * count));
	const drift = count - counts.reduce((a, b) => a + b, 0);
	let biggest = 0;
	for (let i = 1; i < counts.length; i++) {
		if ((counts[i] as number) > (counts[biggest] as number)) biggest = i;
	}
	counts[biggest] = Math.max(0, (counts[biggest] as number) + drift);
	return ranges.map((range, i) => ({ ...range, count: counts[i] as number }));
}

function toMetricDistribution(
	sorted: number[],
	edges: number[],
	count: number,
): MetricDistribution {
	const percentiles = Object.fromEntries(
		PERCENTILE_LEVELS.map(([name, p]) => [name, percentileLower(sorted, p)]),
	) as Record<DistributionPercentile, number>;
	const sum = sorted.reduce((a, b) => a + b, 0);
	return {
		min: sorted[0] ?? 0,
		max: sorted[sorted.length - 1] ?? 0,
		mean: Math.round((sum / sorted.length) * 100) / 100,
		percentiles,
		histogram: scaledHistogram(sorted, edges, count),
	};
}

/**
 * `/api/stats/distribution`. Only `channel` is honoured — the real endpoint 400s on every other
 * filter because `event_sessions` has no column for it (mockApi rejects them the same way).
 */
export function buildDistribution(
	start: number,
	end: number,
	channel?: string,
): SessionDistributionResponse {
	const stats = buildStats(start, end, defaultInterval(start, end));
	const share = channel === undefined ? 1 : shareOf(stats.channels, channel);
	const count = Math.round(stats.engagement.sessions * share);
	const suppressed = count < DEMO_MIN_DISTRIBUTION;
	const sample = suppressed ? null : drawSessionSample(start, end);
	return {
		count,
		suppressed,
		min_count: DEMO_MIN_DISTRIBUTION,
		percentile_method: 'nearest-rank-lower',
		duration_ms: sample && toMetricDistribution(sample.durations, DURATION_EDGES, count),
		pageviews: sample && toMetricDistribution(sample.pages, PAGE_EDGES, count),
		meta: stats.meta ?? { materialization: 'hourly', pending: false },
	};
}

/**
 * `/api/stats/timeseries`. Each line is one top-N key, its range total spread across the window's
 * buckets on the site-wide traffic shape with a per-key wobble — so the lines differ from each other
 * AND from one window to the next. `total` is the sum of the line's own points, exactly as upstream.
 */
/**
 * `/api/stats/breakdown`. Eleven of the nineteen dimensions are already in the stats response; the
 * other eight are columns the real `events` table carries and no other endpoint surfaces, so the
 * demo synthesizes plausible values for them rather than leaving most of the Explore picker dead.
 *
 * `source` is always `d1`: the demo has no Analytics Engine binding, and a fabricated
 * `analytics_engine` label would be the one thing on that panel a reader is entitled to trust.
 */
export function buildBreakdown(
	start: number,
	end: number,
	interval: Interval,
	dimension: BreakdownDimension,
	limit: number,
	filter: DemoStatsFilter = {},
): BreakdownResponse {
	const stats = buildStats(start, end, interval, filter);
	const pv = stats.summary.pageviews;
	const visitors = stats.summary.visitors;
	const lists: Record<BreakdownDimension, CountRow[]> = {
		path: stats.top_paths,
		referrer: stats.top_referrers,
		event: stats.top_events,
		country: stats.top_countries,
		device: stats.top_devices,
		channel: stats.channels,
		browser: stats.top_browsers ?? [],
		os: stats.top_os ?? [],
		language: stats.top_languages ?? [],
		region: stats.top_regions ?? [],
		network: stats.top_networks ?? [],
		hostname: scaled(
			['aperture.example', 'blog.aperture.example', 'docs.aperture.example'],
			pv,
			0.3,
		),
		city: scaled(
			[
				'San Francisco',
				'Mumbai',
				'Berlin',
				'London',
				'Toronto',
				'São Paulo',
				'Paris',
				'Austin',
			],
			visitors,
			0.42,
		),
		timezone: scaled(
			[
				'America/Los_Angeles',
				'Asia/Kolkata',
				'Europe/Berlin',
				'Europe/London',
				'America/New_York',
				'America/Sao_Paulo',
			],
			visitors,
			0.44,
		),
		form_factor: scaled(['desktop', 'phone', 'tablet'], visitors, 0.42),
		utm_source: scaled(
			['newsletter', 'twitter', 'producthunt', 'partner', 'conference'],
			Math.round(pv * 0.22),
			0.45,
		),
		utm_medium: scaled(['email', 'social', 'cpc', 'referral'], Math.round(pv * 0.22), 0.4),
		utm_campaign: scaled(
			['launch-2026', 'spring-sale', 'docs-refresh', 'webinar'],
			Math.round(pv * 0.22),
			0.38,
		),
		currency: scaled(['USD', 'EUR', 'GBP', 'INR'], Math.round(visitors * 0.031), 0.35),
	};
	const rows = (lists[dimension] ?? [])
		.map((row) => ({
			key: row.key,
			events: row.count,
			// Pageviews are a subset of events, and distinct visitors are fewer still — the same two
			// ratios the rest of this dataset is built on, so the panel agrees with the KPI tiles.
			pageviews: Math.round(row.count * 0.86),
			visitors: Math.max(1, Math.round(row.count * 0.41)),
		}))
		.filter((row) => row.visitors >= DEMO_K_ANON)
		.slice(0, limit);
	return { dimension, source: 'd1', sampled: false, rows };
}

export function buildDimensionSeries(
	start: number,
	end: number,
	interval: Interval,
	dimension: SeriesDimension,
	limit: number,
	filter: DemoStatsFilter = {},
): DimensionSeriesResponse {
	const stats = buildStats(start, end, interval, filter);
	const lists: Record<SeriesDimension, CountRow[]> = {
		path: stats.top_paths,
		referrer: stats.top_referrers,
		country: stats.top_countries,
		device: stats.top_devices,
		channel: stats.channels,
	};
	// The real endpoint drops a key below the k-anonymity floor before it can become a line.
	const all = (lists[dimension] ?? []).filter((row) => row.count >= DEMO_K_ANON);
	const rangeTotal = stats.series.reduce((sum, p) => sum + p.pageviews, 0) || 1;

	const series: DimensionSeries[] = all.slice(0, limit).map((row) => {
		const seed = row.key.length * 131 + (row.key.charCodeAt(0) || 0);
		const points: DimensionSeriesPoint[] = stats.series.map((p) => {
			const wobble = 0.75 + rng(hash(p.t, seed))() * 0.5;
			const pageviews = Math.round(row.count * (p.pageviews / rangeTotal) * wobble);
			return { t: p.t, pageviews, events: Math.round(pageviews * 0.18) };
		});
		return {
			key: row.key,
			total: points.reduce((sum, p) => sum + p.pageviews, 0),
			points,
		};
	});
	series.sort((a, b) => b.total - a.total);
	return { dimension, interval, series, truncated: all.length > limit };
}

interface DemoTreeBuilder {
	path: string;
	segment: string;
	depth: number;
	pageviews: number;
	self: number;
	children: Map<string, DemoTreeBuilder>;
}

function demoNode(path: string, segment: string, depth: number): DemoTreeBuilder {
	return { path, segment, depth, pageviews: 0, self: 0, children: new Map() };
}

/** The server's fold: children below the floor or past the cap collapse into one `other` sibling. */
function finalizeDemoNode(node: DemoTreeBuilder): PathTreeNode {
	const all = [...node.children.values()].sort(
		(a, b) => b.pageviews - a.pageviews || a.segment.localeCompare(b.segment),
	);
	const labelled = all.filter((c) => c.pageviews >= DEMO_K_ANON).slice(0, DEMO_TREE_MAX_CHILDREN);
	const folded = all.filter((c) => !labelled.includes(c));
	const children = labelled.map(finalizeDemoNode);
	if (folded.length > 0) {
		const pageviews = folded.reduce((sum, c) => sum + c.pageviews, 0);
		children.push({
			path: node.path === '/' ? '/…' : `${node.path}/…`,
			segment: '…',
			depth: node.depth + 1,
			pageviews,
			self: pageviews,
			children: [],
			other: true,
		});
	}
	return {
		path: node.path,
		segment: node.segment,
		depth: node.depth,
		pageviews: node.pageviews,
		self: node.self,
		children,
	};
}

/** `/api/stats/path-tree`, rolled up from the same `top_paths` the Overview shows, so the treemap's
 * areas agree with the list beside it. */
export function buildPathTree(
	start: number,
	end: number,
	filter: DemoStatsFilter = {},
): PathTreeResponse {
	const stats = buildStats(start, end, defaultInterval(start, end), filter);
	const root = demoNode('/', '', 0);
	for (const row of stats.top_paths) {
		const segments = (row.key.split(/[?#]/)[0] ?? '')
			.split('/')
			.filter((s) => s.length > 0)
			.slice(0, DEMO_TREE_MAX_DEPTH);
		root.pageviews += row.count;
		let node = root;
		for (const segment of segments) {
			const path = node.path === '/' ? `/${segment}` : `${node.path}/${segment}`;
			let child = node.children.get(segment);
			if (!child) {
				child = demoNode(path, segment, node.depth + 1);
				node.children.set(segment, child);
			}
			child.pageviews += row.count;
			node = child;
		}
		node.self += row.count;
	}
	return {
		max_depth: DEMO_TREE_MAX_DEPTH,
		min_count: DEMO_K_ANON,
		root: finalizeDemoNode(root),
		paths: stats.top_paths.length,
		truncated: false,
	};
}

/** `/api/stats/journeys`. Pairs are drawn from the top landing/exit pages with a decaying weight;
 * anything under the distinct-visitor floor is withheld, so `sessions` is deliberately less than
 * `total_sessions` — the gap is what the anonymity floor cost, and the UI should be able to say so. */
export function buildJourneys(start: number, end: number): JourneysResponse {
	const stats = buildStats(start, end, defaultInterval(start, end));
	const totalSessions = stats.engagement.sessions;
	const paths = stats.top_paths.slice(0, 5).map((r) => r.key);
	// Normalized so the pair weights sum to 1 before the coverage factor: the surfaced pairs must
	// never add up to more sessions than the range actually had.
	const entryDecay = paths.map((_, i) => 0.6 ** i);
	const exitDecay = paths.map((_, j) => 0.55 ** j);
	const norm = entryDecay.reduce((a, b) => a + b, 0) * exitDecay.reduce((a, b) => a + b, 0) || 1;
	const pairs: JourneyPair[] = [];
	for (let i = 0; i < paths.length; i++) {
		for (let j = 0; j < paths.length; j++) {
			const weight = ((entryDecay[i] as number) * (exitDecay[j] as number)) / norm;
			// 0.62: the rest of the range's sessions took a journey below the anonymity floor.
			const sessions = Math.round(totalSessions * 0.62 * weight);
			if (sessions < DEMO_K_ANON) continue;
			pairs.push({ entry: paths[i] as string, exit: paths[j] as string, sessions });
		}
	}
	pairs.sort((a, b) => b.sessions - a.sessions || a.entry.localeCompare(b.entry));
	const kept = pairs.slice(0, DEMO_MAX_PAIRS);
	return {
		pairs: kept,
		min_visitors: DEMO_K_ANON,
		sessions: kept.reduce((sum, p) => sum + p.sessions, 0),
		total_sessions: totalSessions,
		meta: stats.meta ?? { materialization: 'hourly', pending: false },
	};
}

/**
 * `/api/stats/clock`. Walks the window's actual UTC hours and folds each one's volume onto the 7 × 24
 * grid using the same diurnal/weekly shapes the rest of the demo is generated from — so the
 * nightingale peaks where the traffic chart peaks. UTC throughout, as upstream: no local-time shift.
 */
export function buildClock(start: number, end: number): ClockResponse {
	const grid = Array.from({ length: 7 * 24 }, () => ({ pageviews: 0, events: 0 }));
	for (let t = floorBucket(start, HOUR_MS); t < end; t += HOUR_MS) {
		const d = new Date(t);
		const slot = grid[d.getUTCDay() * 24 + d.getUTCHours()];
		if (!slot) continue;
		const pageviews = bucketVolume(t, 'hour');
		slot.pageviews += pageviews;
		slot.events += Math.round(pageviews * 0.18);
	}
	const cells: ClockCell[] = [];
	const byHour = new Array<number>(24).fill(0);
	const byDay = new Array<number>(7).fill(0);
	for (let day = 0; day < 7; day++) {
		for (let hour = 0; hour < 24; hour++) {
			const slot = grid[day * 24 + hour] ?? { pageviews: 0, events: 0 };
			cells.push({ day, hour, pageviews: slot.pageviews, events: slot.events });
			byHour[hour] = (byHour[hour] as number) + slot.pageviews;
			byDay[day] = (byDay[day] as number) + slot.pageviews;
		}
	}
	return { timezone: 'UTC', cells, by_hour: byHour, by_day: byDay };
}
