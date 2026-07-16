// NL analytics pipeline over real D1: runQueryIntent scalar/breakdown exactness, the full
// answerQuestion pipeline driven by a stub LlmRunner (no AI binding), and translateQuery fallback.

import { env } from 'cloudflare:test';
import type { QueryIntent } from '@countless/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { runQueryIntent } from '../src/db/nlquery.js';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { answerQuestion, translateQuery } from '../src/lib/ai.js';

const S = '22222222-2222-4222-8222-222222222222';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const H = 3_600_000;

function mk(
	path: string,
	country: string,
	visitor: string,
	name: string | null,
	hour: number,
): NewEvent {
	return {
		siteId: S,
		hostname: 'a.example.com',
		path,
		referrer: '',
		name,
		props: null,
		visitorHash: visitor,
		country,
		device: 'desktop',
		createdAt: T0 + hour * H,
	};
}

const ROWS: NewEvent[] = [
	mk('/', 'US', 'v1', null, 0),
	mk('/', 'US', 'v1', null, 0),
	mk('/pricing', 'US', 'v2', null, 0),
	mk('/pricing', 'DE', 'v3', null, 1),
	mk('/about', 'DE', 'v2', null, 1),
	mk('/', 'US', 'v1', 'signup', 1),
];

const f = { siteId: S, start: T0, end: T0 + 4 * H };

beforeEach(async () => {
	for (const row of ROWS) {
		await insertEvent(env, row);
	}
});

describe('runQueryIntent', () => {
	it('returns a scalar for a pageviews metric', async () => {
		const r = await runQueryIntent(env, S, { metric: 'pageviews' }, f);
		expect(r.result).toEqual({ kind: 'scalar', value: 5 });
		expect(r.answer).toBe('pageviews: 5');
	});

	it('returns a scalar for a visitors metric', async () => {
		const r = await runQueryIntent(env, S, { metric: 'visitors' }, f);
		expect(r.result).toEqual({ kind: 'scalar', value: 3 });
	});

	it('returns a top-paths breakdown for a path dimension', async () => {
		const intent: QueryIntent = { metric: 'pageviews', dimension: 'path' };
		const r = await runQueryIntent(env, S, intent, f);
		expect(r.result).toEqual({
			kind: 'breakdown',
			rows: [
				{ key: '/', count: 3 },
				{ key: '/pricing', count: 2 },
				{ key: '/about', count: 1 },
			],
		});
		expect(r.answer).toBe('Top path by pageviews: / (3), /pricing (2), /about (1)');
	});

	it('applies limit to breakdowns', async () => {
		const intent: QueryIntent = {
			metric: 'pageviews',
			dimension: 'country',
			limit: 1,
		};
		const r = await runQueryIntent(env, S, intent, f);
		expect(r.result).toEqual({
			kind: 'breakdown',
			rows: [{ key: 'US', count: 4 }],
		});
	});
});

const stub = (json: string) => () => Promise.resolve(json);

describe('answerQuestion pipeline', () => {
	it('translates a scalar question and executes it', async () => {
		const r = await answerQuestion(
			env,
			stub('{"metric":"visitors"}'),
			S,
			'how many visitors',
			f,
		);
		expect(r.intent).toEqual({ metric: 'visitors' });
		expect(r.result).toEqual({ kind: 'scalar', value: 3 });
	});

	it('translates a breakdown question and executes it', async () => {
		const r = await answerQuestion(
			env,
			stub('{"dimension":"country","metric":"pageviews"}'),
			S,
			'visitors by country',
			f,
		);
		expect(r.intent).toMatchObject({
			dimension: 'country',
			metric: 'pageviews',
		});
		expect(r.result.kind).toBe('breakdown');
		if (r.result.kind === 'breakdown') {
			expect(r.result.rows).toEqual([
				{ key: 'US', count: 4 },
				{ key: 'DE', count: 2 },
			]);
		}
	});
});

describe('translateQuery', () => {
	it('falls back to the default intent on unparseable model output', async () => {
		expect(await translateQuery(stub('not json at all'), 'x')).toEqual({
			metric: 'pageviews',
		});
	});

	it('falls back when the JSON fails schema validation', async () => {
		expect(await translateQuery(stub('{"metric":"bogus"}'), 'x')).toEqual({
			metric: 'pageviews',
		});
	});

	it('strips code fences before parsing', async () => {
		expect(await translateQuery(stub('```json\n{"metric":"events"}\n```'), 'x')).toEqual({
			metric: 'events',
		});
	});
});
