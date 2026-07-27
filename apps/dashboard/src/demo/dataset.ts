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
	CohortPeriod,
	CohortRetentionResponse,
	CountRow,
	CubeCell,
	CubeResponse,
	Experiment,
	ExperimentResult,
	Funnel,
	FunnelReportResult,
	Goal,
	GoalConversionResult,
	Interval,
	NlQueryResult,
	RealtimeSnapshot,
	Site,
	StatsResponse,
} from '@facet/shared';
import { DEMO_SITE_ID } from './constants.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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

const COUNTRIES: Dim[] = [
	{ key: 'United States', weight: 0.33 },
	{ key: 'India', weight: 0.11 },
	{ key: 'Germany', weight: 0.09 },
	{ key: 'United Kingdom', weight: 0.08 },
	{ key: 'France', weight: 0.06 },
	{ key: 'Canada', weight: 0.05 },
	{ key: 'Brazil', weight: 0.05 },
	{ key: 'other', weight: 0.23 },
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

const CHANNEL_LABELS: Record<string, string> = {
	direct: 'Direct',
	organic: 'Organic search',
	referral: 'Referral',
	social: 'Social',
	paid: 'Paid',
	email: 'Email',
};

/** Build the full stats response for a range, derived from the cube so every number is consistent. */
export function buildStats(start: number, end: number, interval: Interval): StatsResponse {
	const { cells } = buildCube(start, end, interval);
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

	const channels = breakdown(cells, 'channel').map((r) => ({
		key: CHANNEL_LABELS[r.key] ?? r.key,
		count: r.count,
	}));

	const orders = Math.max(1, Math.round(visitors * 0.031));
	const aov = 68.4;
	const revenueTotal = Math.round(orders * aov * 100) / 100;
	const revenueByChannel = CHANNELS.map((c) => ({
		key: CHANNEL_LABELS[c.key] ?? c.key,
		count: Math.round(revenueTotal * c.weight),
	})).sort((a, b) => b.count - a.count);

	const models = ['first', 'last', 'linear', 'position', 'time_decay', 'markov'] as const;
	const attribution: AttributionResult = {
		conversions: orders,
		revenue: revenueTotal,
		models: Object.fromEntries(
			models.map((m, i) => [
				m,
				CHANNELS.map((c, j) => ({
					key: CHANNEL_LABELS[c.key] ?? c.key,
					// Vary credit slightly per model so the model switch is visibly meaningful.
					count: Math.round(revenueTotal * c.weight * (0.7 + ((i + j) % 5) * 0.12)),
				})).sort((a, b) => b.count - a.count),
			]),
		) as Record<AttributionModel, CountRow[]>,
	};

	return {
		summary: { pageviews, visitors, events },
		series,
		top_paths: scaled(
			[
				'/',
				'/pricing',
				'/features',
				'/blog/launch',
				'/docs',
				'/changelog',
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
		top_countries: breakdown(cells, 'country'),
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
		top_screens: scaled(
			['1920×1080', '1440×900', '390×844', '1366×768', '414×896', '2560×1440'],
			visitors,
			0.34,
		),
		top_languages: scaled(
			['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR'],
			visitors,
			0.48,
		),
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
		top_connections: scaled(['4g', 'wifi', '5g', '3g'], visitors, 0.44),
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

export function buildAnomalies(): AnomaliesResponse {
	const bucket = floorBucket(Date.now(), HOUR_MS) - HOUR_MS;
	return {
		anomalies: [
			{
				metric: 'pageviews',
				bucket,
				value: 1840,
				baseline_mean: 940,
				z: 3.4,
				direction: 'spike',
				diagnosis: {
					dimension: 'channel',
					value: 'social',
					current: 720,
					baseline_avg: 180,
				},
				summary:
					'Pageviews spiked ~2× above the hourly baseline, driven mostly by social referrals.',
			},
		],
	};
}

export function buildRetention(period: CohortPeriod): CohortRetentionResponse {
	const periods = period === 'week' ? 6 : 8;
	const cohorts = Array.from({ length: periods }, (_, i) => {
		const day = new Date(Date.now() - (periods - i) * (period === 'week' ? 7 : 1) * DAY_MS);
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

export function buildFunnelReport(): FunnelReportResult {
	const counts = [12_400, 5_180, 2_240, 968];
	const labels = ['/', '/pricing', 'add_to_cart', 'checkout'];
	const steps = counts.map((count, index) => ({
		index,
		match_value: labels[index] ?? '',
		count,
	}));
	const first = counts[0] ?? 1;
	const last = counts[counts.length - 1] ?? 0;
	return { steps, overall_rate: last / first };
}

export function buildConversions(goalId: string): GoalConversionResult {
	const conversions = goalId === 'g2' ? 968 : 2_610;
	const sessions = 34_800;
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

export function buildExperimentResult(): ExperimentResult {
	return {
		variants: [
			{
				key: 'control',
				exposures: 8_420,
				conversions: 421,
				rate: 0.05,
				p_value: null,
				significant: false,
			},
			{
				key: 'urgency',
				exposures: 8_390,
				conversions: 512,
				rate: 0.061,
				p_value: 0.017,
				significant: true,
			},
		],
	};
}

export function buildInteractions(): { interactions: CountRow[] } {
	return {
		interactions: scaled(
			['click', 'scroll_75', 'form_submit', 'copy', 'outbound_click', 'video_play'],
			22_000,
			0.4,
		),
	};
}

export function buildNlQuery(question: string): NlQueryResult {
	const asked = question.trim() ? `You asked: “${question.trim()}”. ` : '';
	return {
		intent: { metric: 'visitors', dimension: 'country', limit: 5 },
		answer: `${asked}Over the selected range, the United States is the largest source of visitors (~33%), followed by India and Germany. This is a demo response computed from fabricated data.`,
		result: {
			kind: 'breakdown',
			rows: [
				{ key: 'United States', count: 14_820 },
				{ key: 'India', count: 4_940 },
				{ key: 'Germany', count: 4_040 },
				{ key: 'United Kingdom', count: 3_590 },
				{ key: 'France', count: 2_690 },
			],
		},
	};
}
