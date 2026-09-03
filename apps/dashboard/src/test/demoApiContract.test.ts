// Contract test for the static demo's in-browser API (`demo/mockApi.ts`).
//
// The demo is the one build with no server to check against, so a mock that drifts from
// `apps/server/src/routes/*` is undetectable by eye — it just answers plausibly and wrongly. Two
// classes of drift have already shipped: `/api/stats/query` ignored `start`/`end`, so the Ask tab's
// answer-window chips returned one frozen fixture for every window; and `top_countries` emitted
// display names where the real API emits ISO A2, so the demo's choropleth matched nothing and
// rendered as an unlit outline.
//
// Both would have passed a shape-only check. So this asserts the three properties that actually
// catch them:
//   1. RANGE IS LOAD-BEARING — every range-scoped endpoint must answer differently for two different
//      windows, and must reject an invalid window the way the real handler's `assertRange` does.
//   2. KEY SPACE — a breakdown's keys must be in the same vocabulary the real API emits (ISO A2
//      countries, raw lowercase channels), not a presentational relabelling of it.
//   3. SHAPE — the response must satisfy the `@facet/shared` type the dashboard parses it as,
//      including the envelope shapes (`{columns, rows}`) that differ from the domain objects.

import type {
	AnomaliesResponse,
	CohortRetentionResponse,
	CountRow,
	CubeResponse,
	ExperimentResult,
	FunnelReportResult,
	GoalConversionResult,
	NlQueryResult,
	RealtimeContextResponse,
	RealtimeSnapshot,
	StatsAcquisitionResponse,
	StatsAttributionResponse,
	StatsContentResponse,
	StatsCoreResponse,
	StatsEngagementResponse,
	StatsFreshnessResponse,
	StatsResponse,
	StatsRevenueResponse,
	StatsSummaryResponse,
	StatsTechnologyResponse,
} from '@facet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_SITE_ID } from '../demo/constants.js';
import { installDemoApi } from '../demo/mockApi.js';

const DAY_MS = 86_400_000;
const END = Date.UTC(2026, 5, 15);
const WEEK = { start: END - 7 * DAY_MS, end: END };
const MONTH = { start: END - 30 * DAY_MS, end: END };

const originalFetch = window.fetch;

beforeAll(() => {
	installDemoApi();
});

afterAll(() => {
	window.fetch = originalFetch;
});

function range(r: { start: number; end: number }): string {
	return `site_id=${DEMO_SITE_ID}&start=${r.start}&end=${r.end}`;
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
	const res = await fetch(path);
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function ok<T>(path: string): Promise<T> {
	const res = await get(path);
	expect(res.status, `${path} should be 200`).toBe(200);
	return res.body as T;
}

async function ask(question: string, r: { start: number; end: number }) {
	const res = await fetch('/api/stats/query', {
		method: 'POST',
		body: JSON.stringify({ site_id: DEMO_SITE_ID, question, ...r }),
	});
	return { status: res.status, body: (await res.json()) as NlQueryResult };
}

// ── Shape assertors ───────────────────────────────────────────────────────────────────────────────
// Hand-written because the response types are interfaces, not schemas: TypeScript checks the call
// sites, these check the bytes.

function expectCountRows(rows: unknown, label: string): asserts rows is CountRow[] {
	expect(Array.isArray(rows), `${label} must be an array`).toBe(true);
	for (const row of rows as CountRow[]) {
		expect(typeof row.key, `${label}.key`).toBe('string');
		expect(Number.isFinite(row.count), `${label}.count`).toBe(true);
	}
}

function expectStatsResponse(body: StatsResponse): void {
	for (const metric of ['pageviews', 'visitors', 'events'] as const) {
		expect(Number.isFinite(body.summary[metric]), `summary.${metric}`).toBe(true);
	}
	expect(Array.isArray(body.series)).toBe(true);
	for (const point of body.series) {
		expect(Number.isFinite(point.t)).toBe(true);
		expect(Number.isFinite(point.pageviews)).toBe(true);
		expect(Number.isFinite(point.visitors)).toBe(true);
	}
	for (const field of [
		'top_paths',
		'top_referrers',
		'top_events',
		'top_countries',
		'top_devices',
		'channels',
	] as const) {
		expectCountRows(body[field], field);
	}
	for (const field of [
		'sessions',
		'bounce_rate',
		'pages_per_session',
		'avg_duration_ms',
	] as const) {
		expect(Number.isFinite(body.engagement[field]), `engagement.${field}`).toBe(true);
	}
}

describe('demo API contract: the range is load-bearing', () => {
	// Every one of these is a range-scoped read upstream, so widening the window MUST move the answer.
	// A fixture that ignores its range is indistinguishable from a working endpoint without this.
	const rangeScoped: { path: string; extra?: string }[] = [
		{ path: '/api/stats' },
		{ path: '/api/stats/core' },
		{ path: '/api/stats/summary' },
		{ path: '/api/stats/content' },
		{ path: '/api/stats/acquisition' },
		{ path: '/api/stats/technology' },
		{ path: '/api/stats/engagement' },
		{ path: '/api/stats/revenue' },
		{ path: '/api/stats/realtime-context' },
		{ path: '/api/stats/attribution' },
		{ path: '/api/stats/cube' },
		{ path: '/api/stats/interactions' },
		{ path: '/api/stats/conversions', extra: 'goal_id=g1' },
		{
			path: '/api/stats/experiment',
			extra: 'experiment_id=e1&goal_type=event&goal_value=signup',
		},
		{ path: '/api/funnels/f1/report' },
	];

	for (const { path, extra } of rangeScoped) {
		it(`${path} answers differently for a 7-day and a 30-day window`, async () => {
			const suffix = extra ? `&${extra}` : '';
			const week = await ok(`${path}?${range(WEEK)}${suffix}`);
			const month = await ok(`${path}?${range(MONTH)}${suffix}`);
			expect(JSON.stringify(week)).not.toBe(JSON.stringify(month));
		});
	}

	it('/api/stats/retention scales its cohort count to the window', async () => {
		const short = await ok<CohortRetentionResponse>(
			`/api/stats/retention?${range({ start: END - 2 * DAY_MS, end: END })}&period=day`,
		);
		const long = await ok<CohortRetentionResponse>(
			`/api/stats/retention?${range(MONTH)}&period=day`,
		);
		expect(short.cohorts.length).toBeLessThan(long.cohorts.length);
	});

	it('/api/stats/anomalies only reports buckets inside the window', async () => {
		const body = await ok<AnomaliesResponse>(`/api/stats/anomalies?${range(WEEK)}`);
		for (const a of body.anomalies) {
			expect(a.bucket).toBeGreaterThanOrEqual(WEEK.start);
			expect(a.bucket).toBeLessThan(WEEK.end);
		}
	});

	// The regression this file exists for: the Ask panel offers per-answer window chips, and every
	// chip used to produce byte-identical output.
	it('/api/stats/query answers the window it was given, not a fixed one', async () => {
		const week = await ask('How many pageviews this period?', WEEK);
		const month = await ask('How many pageviews this period?', MONTH);
		expect(week.status).toBe(200);
		expect(week.body.result.kind).toBe('scalar');
		expect(month.body.result.kind).toBe('scalar');
		if (week.body.result.kind !== 'scalar' || month.body.result.kind !== 'scalar') return;
		expect(month.body.result.value).toBeGreaterThan(week.body.result.value);
	});

	it('/api/stats/query breakdowns move with the window too', async () => {
		const week = await ask('Top countries', WEEK);
		const month = await ask('Top countries', MONTH);
		if (week.body.result.kind !== 'breakdown' || month.body.result.kind !== 'breakdown') {
			throw new Error('expected a breakdown for a country question');
		}
		expect(week.body.result.rows.length).toBeGreaterThan(0);
		expect(month.body.result.rows[0]?.count).toBeGreaterThan(
			week.body.result.rows[0]?.count ?? 0,
		);
	});

	it('/api/stats narrows on the dimension filters the real API honours', async () => {
		const all = await ok<StatsResponse>(`/api/stats?${range(MONTH)}`);
		const mobile = await ok<StatsResponse>(`/api/stats?${range(MONTH)}&device=mobile`);
		expect(mobile.summary.pageviews).toBeGreaterThan(0);
		expect(mobile.summary.pageviews).toBeLessThan(all.summary.pageviews);
		const firstPath = all.top_paths[0]?.key ?? '/';
		const byPath = await ok<StatsResponse>(
			`/api/stats?${range(MONTH)}&path=${encodeURIComponent(firstPath)}`,
		);
		expect(byPath.summary.pageviews).toBeLessThan(all.summary.pageviews);
	});
});

describe('demo API contract: range validation matches the server', () => {
	it('rejects an empty range with bad_range, as assertRange does', async () => {
		// This is the exact request a caller with an unresolved window sends. The mock used to
		// substitute a trailing 7-day window and answer 200, hiding the caller's bug.
		const res = await get(`/api/stats?site_id=${DEMO_SITE_ID}&start=0&end=0`);
		expect(res.status).toBe(400);
		expect((res.body as { error: string }).error).toBe('bad_range');
	});

	it('rejects a range wider than the 90-day maximum', async () => {
		const res = await get(`/api/stats?${range({ start: END - 120 * DAY_MS, end: END })}`);
		expect(res.status).toBe(400);
		expect((res.body as { error: string }).error).toBe('range_too_large');
	});

	it('rejects an empty answer window on the Ask endpoint', async () => {
		const res = await ask('anything', { start: 0, end: 0 });
		expect(res.status).toBe(400);
	});

	it('404s an unknown goal, funnel and experiment instead of answering for another', async () => {
		expect((await get(`/api/stats/conversions?${range(WEEK)}&goal_id=nope`)).status).toBe(404);
		expect((await get(`/api/funnels/nope/report?${range(WEEK)}`)).status).toBe(404);
		expect(
			(
				await get(
					`/api/stats/experiment?${range(WEEK)}&experiment_id=nope&goal_type=event&goal_value=signup`,
				)
			).status,
		).toBe(404);
	});

	it('400s an experiment query with no usable goal', async () => {
		const res = await get(`/api/stats/experiment?${range(WEEK)}&experiment_id=e1`);
		expect(res.status).toBe(400);
		expect((res.body as { error: string }).error).toBe('bad_goal');
	});

	it('refuses writes: the demo is read-only', async () => {
		const res = await fetch('/api/sites', {
			method: 'POST',
			body: JSON.stringify({ name: 'x', domain: 'x.example' }),
		});
		expect(res.status).toBe(403);
	});
});

describe('demo API contract: breakdown keys are in the real API key space', () => {
	it('emits ISO A2 country codes, never display names', async () => {
		const body = await ok<StatsResponse>(`/api/stats?${range(MONTH)}`);
		expect(body.top_countries.length).toBeGreaterThan(0);
		for (const row of body.top_countries) {
			// WorldMap looks these up as `r.key.toUpperCase()` against ISO A2 geometry keys, so the
			// key must already BE that lookup key. 'United States' is the shape that broke the map.
			expect(row.key, 'country key must be ISO A2').toMatch(/^[A-Z]{2}$/);
			expect(row.key).toBe(row.key.toUpperCase());
		}
		// `other` is the cube's fold bucket; the raw-column breakdown upstream cannot contain it.
		expect(body.top_countries.map((r) => r.key)).not.toContain('other');
	});

	it("keeps the cube's country axis on the same codes plus the fold bucket", async () => {
		const cube = await ok<CubeResponse>(`/api/stats/cube?${range(WEEK)}`);
		expect(cube.cells.length).toBeGreaterThan(0);
		for (const cell of cube.cells) {
			expect(cell.country === 'other' || /^[A-Z]{2}$/.test(cell.country)).toBe(true);
		}
	});

	it('emits raw lowercase channel keys, matching the cube axis it cross-filters', async () => {
		const body = await ok<StatsResponse>(`/api/stats?${range(WEEK)}`);
		const cube = await ok<CubeResponse>(`/api/stats/cube?${range(WEEK)}`);
		const cubeChannels = new Set(cube.cells.map((c) => c.channel));
		expect(body.channels.length).toBeGreaterThan(0);
		for (const row of body.channels) {
			// A channel row the cube cannot match is a row whose click filters everything away.
			expect(cubeChannels.has(row.key), `channel '${row.key}' is not a cube key`).toBe(true);
		}
		for (const row of body.revenue_by_channel ?? []) {
			expect(cubeChannels.has(row.key)).toBe(true);
		}
		for (const rows of Object.values(body.attribution?.models ?? {})) {
			for (const row of rows) expect(cubeChannels.has(row.key)).toBe(true);
		}
	});

	it('emits device keys from the real device vocabulary', async () => {
		const body = await ok<StatsResponse>(`/api/stats?${range(WEEK)}`);
		for (const row of body.top_devices) {
			expect(['mobile', 'tablet', 'desktop']).toContain(row.key);
		}
	});
});

describe('demo API contract: response shapes', () => {
	it('/api/stats satisfies StatsResponse', async () => {
		expectStatsResponse(await ok<StatsResponse>(`/api/stats?${range(WEEK)}`));
	});

	it('satisfies the narrow stats response contracts', async () => {
		const core = await ok<StatsCoreResponse>(`/api/stats/core?${range(WEEK)}`);
		expect(Object.keys(core).sort()).toEqual(['series', 'summary']);

		const summary = await ok<StatsSummaryResponse>(`/api/stats/summary?${range(WEEK)}`);
		expect(Object.keys(summary)).toEqual(['summary']);

		const freshness = await ok<StatsFreshnessResponse>(`/api/stats/freshness?${range(WEEK)}`);
		expect(freshness.meta.materialization).toBe('hourly');

		const realtime = await ok<RealtimeContextResponse>(
			`/api/stats/realtime-context?${range(WEEK)}`,
		);
		expectCountRows(realtime.top_paths, 'realtime.top_paths');
		expectCountRows(realtime.channels, 'realtime.channels');

		const attribution = await ok<StatsAttributionResponse>(
			`/api/stats/attribution?${range(WEEK)}`,
		);
		expect(Number.isFinite(attribution.revenue.total)).toBe(true);
		expect(Number.isFinite(attribution.attribution.revenue)).toBe(true);
		expect(attribution.attribution.meta).toMatchObject({
			exact: true,
			truncated: false,
			range_supported: true,
		});

		const content = await ok<StatsContentResponse>(`/api/stats/content?${range(WEEK)}`);
		expectCountRows(content.top_paths, 'content.top_paths');
		expectCountRows(content.top_events, 'content.top_events');

		const acquisition = await ok<StatsAcquisitionResponse>(
			`/api/stats/acquisition?${range(WEEK)}`,
		);
		expectCountRows(acquisition.top_referrers, 'acquisition.top_referrers');

		const technology = await ok<StatsTechnologyResponse>(
			`/api/stats/technology?${range(WEEK)}`,
		);
		expectCountRows(technology.top_browsers, 'technology.top_browsers');
		expectCountRows(technology.top_connections, 'technology.top_connections');

		const engagement = await ok<StatsEngagementResponse>(
			`/api/stats/engagement?${range(WEEK)}`,
		);
		expect(Number.isFinite(engagement.engagement.sessions)).toBe(true);

		const revenue = await ok<StatsRevenueResponse>(`/api/stats/revenue?${range(WEEK)}`);
		expect(Number.isFinite(revenue.revenue.total)).toBe(true);
		expect(revenue).not.toHaveProperty('attribution');
	});

	it('/api/stats/cube satisfies CubeResponse and buckets by the same rule as the server', async () => {
		const daily = await ok<CubeResponse>(`/api/stats/cube?${range(MONTH)}`);
		expect(daily.interval).toBe('day');
		for (const cell of daily.cells) {
			expect(Number.isFinite(cell.t)).toBe(true);
			expect(Number.isFinite(cell.pageviews)).toBe(true);
			expect(Number.isFinite(cell.visitors)).toBe(true);
			expect(Number.isFinite(cell.events)).toBe(true);
		}
		// Under 48h with no explicit interval the server buckets hourly; the mock defaulted to `day`.
		const short = await ok<CubeResponse>(
			`/api/stats/cube?${range({ start: END - DAY_MS, end: END })}`,
		);
		expect(short.interval).toBe('hour');
	});

	it('/api/stats/realtime satisfies RealtimeSnapshot', async () => {
		const body = await ok<RealtimeSnapshot>(`/api/stats/realtime?site_id=${DEMO_SITE_ID}`);
		for (const field of ['window_ms', 'visitors', 'pageviews', 'until'] as const) {
			expect(Number.isFinite(body[field]), field).toBe(true);
		}
	});

	it('/api/stats/retention satisfies CohortRetentionResponse', async () => {
		const body = await ok<CohortRetentionResponse>(
			`/api/stats/retention?${range(MONTH)}&period=week`,
		);
		expect(body.period).toBe('week');
		expect(typeof body.note).toBe('string');
		for (const cohort of body.cohorts) {
			expect(cohort.cohort).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(Number.isFinite(cohort.size)).toBe(true);
			expect(cohort.retention[0]).toBe(1);
		}
	});

	it('/api/stats/conversions and /api/stats/experiment satisfy their result types', async () => {
		const conv = await ok<GoalConversionResult>(
			`/api/stats/conversions?${range(WEEK)}&goal_id=g1`,
		);
		expect(conv.goal_id).toBe('g1');
		expect(conv.rate).toBeCloseTo(conv.conversions / conv.sessions, 10);
		const exp = await ok<ExperimentResult>(
			`/api/stats/experiment?${range(WEEK)}&experiment_id=e1&goal_type=event&goal_value=signup`,
		);
		for (const v of exp.variants) {
			expect(typeof v.key).toBe('string');
			expect(Number.isFinite(v.exposures)).toBe(true);
			expect(Number.isFinite(v.conversions)).toBe(true);
			expect(v.p_value === null || Number.isFinite(v.p_value)).toBe(true);
		}
	});

	it('/api/funnels/:id/report satisfies FunnelReportResult', async () => {
		const body = await ok<FunnelReportResult>(`/api/funnels/f1/report?${range(WEEK)}`);
		expect(body.steps.length).toBeGreaterThan(0);
		body.steps.forEach((step, i) => {
			expect(step.index).toBe(i);
			expect(Number.isFinite(step.count)).toBe(true);
		});
		expect(body.overall_rate).toBeGreaterThan(0);
		expect(body.overall_rate).toBeLessThanOrEqual(1);
	});

	it('/api/stats/interactions returns a CountRow list under `interactions`', async () => {
		const body = await ok<{ interactions: CountRow[] }>(
			`/api/stats/interactions?${range(WEEK)}`,
		);
		expectCountRows(body.interactions, 'interactions');
	});

	it('/api/stats/query returns an intent from the closed vocabulary plus one of three kinds', async () => {
		const metrics = ['pageviews', 'visitors', 'events', 'sessions', 'bounce_rate'];
		const dimensions = ['path', 'referrer', 'country', 'device', 'channel'];
		for (const question of ['Top pages', 'Show the pageview trend by day', 'Top referrers']) {
			const { body } = await ask(question, MONTH);
			expect(metrics, question).toContain(body.intent.metric);
			if (body.intent.dimension) expect(dimensions).toContain(body.intent.dimension);
			expect(typeof body.answer).toBe('string');
			expect(['scalar', 'breakdown', 'series']).toContain(body.result.kind);
			if (body.result.kind === 'breakdown') expectCountRows(body.result.rows, question);
		}
	});

	it('/api/stats/export uses the tabular {columns, rows} envelope, not the domain objects', async () => {
		const series = (await ok<{ columns: string[]; rows: unknown[][] }>(
			`/api/stats/export?${range(WEEK)}&kind=series&format=json`,
		)) satisfies { columns: string[]; rows: unknown[][] };
		expect(series.columns).toEqual([
			'bucket_start_iso',
			'bucket_start_ms',
			'pageviews',
			'visitors',
		]);
		expect(series.rows[0]?.length).toBe(series.columns.length);

		const breakdown = await ok<{ columns: string[]; rows: unknown[][] }>(
			`/api/stats/export?${range(WEEK)}&kind=breakdown&dimension=country&format=json`,
		);
		expect(breakdown.columns).toEqual(['key', 'count']);

		// CSV carries the same header, and the download helper relies on the attachment disposition.
		const csv = await fetch(`/api/stats/export?${range(WEEK)}&kind=series&format=csv`);
		expect(csv.headers.get('content-type')).toContain('text/csv');
		expect(csv.headers.get('content-disposition')).toContain('attachment');
		expect((await csv.text()).split('\n')[0]).toBe(series.columns.join(','));
	});

	it('/api/stats/export honours `limit` and rejects an unknown dimension', async () => {
		const limited = await ok<{ rows: unknown[][] }>(
			`/api/stats/export?${range(WEEK)}&kind=breakdown&dimension=path&format=json&limit=2`,
		);
		expect(limited.rows.length).toBe(2);
		expect(
			(
				await get(
					`/api/stats/export?${range(WEEK)}&kind=breakdown&dimension=nope&format=json`,
				)
			).status,
		).toBe(400);
	});

	it('/api/keys requires site_id, as the admin route does', async () => {
		expect((await get('/api/keys')).status).toBe(400);
		expect((await get(`/api/keys?site_id=${DEMO_SITE_ID}`)).status).toBe(200);
	});
});
