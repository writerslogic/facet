// The client compute engine: filtering + re-aggregation over the in-memory cube. Asserts the exactness
// contract — pageviews/events are exact under any slice, visitors is an upper bound flagged when a
// slice spans multiple cells in a bucket — plus dimension ordering and series re-bucketing.

import type { CubeCell } from '@facet/shared';
import { describe, expect, it } from 'vitest';
import {
	cubeBreakdown,
	cubeDimensions,
	cubeSeries,
	isFilterActive,
	sliceCube,
} from '../lib/cube.js';

const T0 = 0;
const T1 = 3_600_000;
const CELLS: CubeCell[] = [
	{
		t: T0,
		device: 'mobile',
		country: 'US',
		channel: 'organic',
		pageviews: 5,
		events: 1,
		visitors: 3,
	},
	{
		t: T0,
		device: 'desktop',
		country: 'US',
		channel: 'direct',
		pageviews: 10,
		events: 0,
		visitors: 6,
	},
	{
		t: T1,
		device: 'mobile',
		country: 'GB',
		channel: 'organic',
		pageviews: 2,
		events: 0,
		visitors: 2,
	},
	{
		t: T1,
		device: 'mobile',
		country: 'US',
		channel: 'direct',
		pageviews: 4,
		events: 1,
		visitors: 2,
	},
];

describe('cube client indexer', () => {
	it('sliceCube: pageviews/events exact; visitors an upper bound flagged when a bucket has >1 matching cell', () => {
		// device=mobile matches cells 1,3,4. Bucket T1 has two matching cells → approximate.
		expect(sliceCube(CELLS, { device: 'mobile' })).toEqual({
			pageviews: 11,
			events: 2,
			visitors: 7,
			visitorsApproximate: true,
		});
		// device=mobile & country=US pins one cell per bucket → exact.
		expect(sliceCube(CELLS, { device: 'mobile', country: 'US' })).toEqual({
			pageviews: 9,
			events: 2,
			visitors: 5,
			visitorsApproximate: false,
		});
	});

	it('cubeSeries: filters then re-buckets ascending', () => {
		expect(cubeSeries(CELLS, { device: 'mobile' })).toEqual([
			{ t: T0, pageviews: 5, visitors: 3 },
			{ t: T1, pageviews: 6, visitors: 4 },
		]);
	});

	it('cubeDimensions: distinct values per axis ordered by total pageviews descending', () => {
		expect(cubeDimensions(CELLS)).toEqual({
			device: ['mobile', 'desktop'],
			country: ['US', 'GB'],
			channel: ['direct', 'organic'],
		});
	});

	it('isFilterActive reflects whether any axis is constrained', () => {
		expect(isFilterActive({})).toBe(false);
		expect(isFilterActive({ country: 'US' })).toBe(true);
	});

	it('cubeBreakdown: re-ranks under the OTHER axes but ignores its own (stays switchable)', () => {
		// Unfiltered: US = 5+10+4, GB = 2.
		expect(cubeBreakdown(CELLS, {}, 'country')).toEqual([
			{ key: 'US', count: 19 },
			{ key: 'GB', count: 2 },
		]);
		// device=mobile re-ranks countries to mobile's cells (1,3,4): US = 5+4, GB = 2.
		expect(cubeBreakdown(CELLS, { device: 'mobile' }, 'country')).toEqual([
			{ key: 'US', count: 9 },
			{ key: 'GB', count: 2 },
		]);
		// Selecting a country does NOT collapse the country list — its own axis is ignored.
		expect(cubeBreakdown(CELLS, { country: 'US' }, 'country')).toEqual([
			{ key: 'US', count: 19 },
			{ key: 'GB', count: 2 },
		]);
		// The device list likewise shows all devices even when a device is selected.
		expect(cubeBreakdown(CELLS, { device: 'mobile' }, 'device')).toEqual([
			{ key: 'mobile', count: 11 },
			{ key: 'desktop', count: 10 },
		]);
	});
});
