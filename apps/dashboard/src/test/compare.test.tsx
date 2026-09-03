// Period-over-period comparison: the movement model, the breakdown rules that decide when a
// comparison is honest, and the wiring that must not fabricate one.
//
// The rules under test are the ones that are easy to get wrong and impossible to spot afterwards:
// a key absent from a TRUNCATED previous list is not "new", a percentage over a base of three is
// not information, and a comparison window that a filter never touched must not be subtracted from
// a filtered current period.

import type { CountRow, StatsResponse } from '@facet/shared';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BreakdownList } from '../components/CompareList.js';
import { DeltaBadge } from '../components/Delta.js';
import {
	MIN_RATE_EXPOSURES,
	canComparePeriod,
	variantMovements,
} from '../components/Experiments.js';
import { curveComparison } from '../components/Retention.js';
import { PreviousPeriodProvider } from '../hooks/compare.js';
import { compareBreakdown, droppedMovement } from '../lib/compare.js';
import {
	LOW_VOLUME_BASE,
	countMovement,
	movementLabel,
	rateMovement,
	toMovement,
} from '../lib/format.js';

const rows = (...pairs: [string, number][]): CountRow[] =>
	pairs.map(([key, count]) => ({ key, count }));

describe('countMovement', () => {
	it('is a percentage once the base is big enough to carry one', () => {
		const m = countMovement(122, 100);
		expect(m).toEqual({ kind: 'pct', value: 0.22, sense: 'improvement' });
		expect(movementLabel(m as never)).toBe('+22%');
	});

	it('reports an absolute change when the base is too small for a percentage', () => {
		const m = countMovement(9, 3);
		expect(m?.kind).toBe('count');
		expect(movementLabel(m as never)).toBe('+6');
		// The boundary is the base, not the change: 20 → 30 is a percentage, 19 → 30 is not.
		expect(countMovement(30, LOW_VOLUME_BASE)?.kind).toBe('pct');
		expect(countMovement(30, LOW_VOLUME_BASE - 1)?.kind).toBe('count');
	});

	it('never invents a comparison out of a missing previous value', () => {
		expect(countMovement(500, null)).toBeNull();
		expect(countMovement(500, undefined)).toBeNull();
		// Both zero is not a movement either — there is nothing to say, so nothing is said.
		expect(countMovement(0, 0)).toBeNull();
	});

	it('calls a jump from nothing new, and a fall to nothing gone', () => {
		expect(countMovement(500, 0)?.kind).toBe('new');
		expect(movementLabel(countMovement(500, 0) as never)).toBe('new');
		expect(countMovement(0, 500)?.kind).toBe('gone');
		expect(countMovement(0, 500)?.sense).toBe('regression');
	});

	it('reads the direction of the metric, not just the sign', () => {
		expect(countMovement(50, 100, 'up')?.sense).toBe('regression');
		expect(countMovement(50, 100, 'down')?.sense).toBe('improvement');
		expect(countMovement(50, 100, 'neutral')?.sense).toBe('neutral');
	});
});

describe('rateMovement', () => {
	it('is percentage points, never percent of a percent', () => {
		const m = rateMovement(0.48, 0.4);
		expect(m?.kind).toBe('points');
		// 40% → 48% is +8 points. "+20%" is the misread this type exists to prevent.
		expect(movementLabel(m as never)).toBe('+8.0 pts');
	});

	it('has nothing to say when either rate is missing', () => {
		expect(rateMovement(0.4, null)).toBeNull();
		expect(rateMovement(null, 0.4)).toBeNull();
	});
});

describe('toMovement', () => {
	it('carries the older Delta shape onto the shared model', () => {
		expect(toMovement({ absolute: 5, pct: 0.5, isNew: false, sense: 'improvement' })).toEqual({
			kind: 'pct',
			value: 0.5,
			sense: 'improvement',
		});
		expect(toMovement({ absolute: 5, pct: null, isNew: true, sense: 'improvement' }).kind).toBe(
			'new',
		);
	});
});

describe('compareBreakdown', () => {
	it('matches keys rather than positions, so a re-ranked list still compares correctly', () => {
		const c = compareBreakdown(
			rows(['/pricing', 122], ['/features', 60]),
			rows(['/features', 100], ['/pricing', 100]),
		);
		expect(movementLabel(c.movements.get('/pricing') as never)).toBe('+22%');
		expect(movementLabel(c.movements.get('/features') as never)).toBe('−40%');
	});

	it('calls a key NEW only when the previous list provably held everything it had', () => {
		// Previous list is shorter than the current one, so it was not truncated: /new really is new.
		const c = compareBreakdown(
			rows(['/a', 100], ['/b', 90], ['/new', 80]),
			rows(['/a', 100], ['/b', 90]),
		);
		expect(c.movements.get('/new')?.kind).toBe('new');
	});

	it('says "entered" — not "new" — when the previous list may have truncated the key', () => {
		// Same length both sides: the previous list could have been cut off at its smallest row (50),
		// so a key above that certainly rose, but by an unknown amount.
		const c = compareBreakdown(
			rows(['/a', 100], ['/riser', 80]),
			rows(['/a', 100], ['/b', 50]),
		);
		expect(c.movements.get('/riser')?.kind).toBe('entered');
		// And a key BELOW the previous cut could have moved either way, so it gets nothing at all.
		const d = compareBreakdown(
			rows(['/a', 100], ['/small', 20]),
			rows(['/a', 100], ['/b', 50]),
		);
		expect(d.movements.has('/small')).toBe(false);
	});

	it('surfaces a disappearance, and only calls it gone when the current list is complete', () => {
		const gone = compareBreakdown(rows(['/a', 100]), rows(['/a', 100], ['/dead', 90]));
		expect(gone.dropped).toEqual([{ key: '/dead', previous: 90, certain: true }]);
		expect(droppedMovement(gone.dropped[0] as never).kind).toBe('gone');

		// Equal lengths: /dead outranked the current list's floor, so it certainly fell out of it —
		// but the current list may simply have truncated it, so it is not called "gone".
		const left = compareBreakdown(
			rows(['/a', 100], ['/b', 20]),
			rows(['/a', 100], ['/dead', 90]),
		);
		expect(left.dropped[0]).toEqual({ key: '/dead', previous: 90, certain: false });
		expect(droppedMovement(left.dropped[0] as never).kind).toBe('count');
	});

	it('does not report a small key as dropped when it may just be below the cut', () => {
		const c = compareBreakdown(rows(['/a', 100], ['/b', 90]), rows(['/a', 100], ['/tiny', 5]));
		expect(c.dropped).toEqual([]);
	});

	it('is empty — never zeroes — when there is no preceding list', () => {
		expect(compareBreakdown(rows(['/a', 100]), null).movements.size).toBe(0);
		expect(compareBreakdown(rows(['/a', 100]), []).movements.size).toBe(0);
	});
});

describe('DeltaBadge', () => {
	it('renders nothing at all for an unavailable comparison', () => {
		const { container } = render(<DeltaBadge movement={null} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('pairs every movement with a word, never colour alone', () => {
		render(<DeltaBadge movement={{ kind: 'pct', value: -0.4, sense: 'regression' }} />);
		expect(screen.getByText('−40%')).toBeInTheDocument();
		expect(screen.getByText(/worsened versus the previous period/)).toBeInTheDocument();
	});

	it('reads as flat in every channel when the change rounds away', () => {
		// A value of -1e-17 printed "±0.0 pts" beside a red down-arrow: text, icon and colour must
		// agree, so the rounded LABEL decides all three.
		render(<DeltaBadge movement={{ kind: 'points', value: -1e-17, sense: 'regression' }} />);
		expect(screen.getByText('±0.0 pts')).toBeInTheDocument();
		expect(screen.getByText(/unchanged versus the previous period/)).toBeInTheDocument();
		expect(screen.queryByText(/worsened/)).toBeNull();
	});

	it('never prints a signed zero percent', () => {
		expect(movementLabel({ kind: 'pct', value: 0.00004, sense: 'improvement' })).toBe('±0%');
		expect(movementLabel({ kind: 'pct', value: 0.001, sense: 'improvement' })).toBe('+0.1%');
	});

	it('states its comparison window in the tooltip', () => {
		render(<DeltaBadge movement={{ kind: 'new', value: 0, sense: 'improvement' }} />);
		expect(screen.getByTitle(/Not present in the equal-length preceding period/)).toBeVisible();
	});
});

describe('curveComparison (retention)', () => {
	const cohorts = (size: number, retention: number[]) => [{ cohort: 'c', size, retention }];

	it('compares the same offsets in percentage points', () => {
		const m = curveComparison(cohorts(400, [1, 0.5]), cohorts(400, [1, 0.4]), 2);
		expect(m[0]?.value).toBeCloseTo(0);
		expect(movementLabel(m[1] as never)).toBe('+10.0 pts');
	});

	it('refuses an offset either window has too few visitors behind', () => {
		expect(curveComparison(cohorts(400, [1, 0.5]), cohorts(10, [1, 0.4]), 2)[1]).toBeNull();
		expect(curveComparison(cohorts(10, [1, 0.5]), cohorts(400, [1, 0.4]), 2)[1]).toBeNull();
	});

	it('refuses an offset one window has not reached', () => {
		expect(curveComparison(cohorts(400, [1, 0.5]), cohorts(400, [1]), 2)[1]).toBeNull();
	});

	it('has nothing to compare without preceding cohorts', () => {
		expect(curveComparison(cohorts(400, [1, 0.5]), null, 2)).toEqual([null, null]);
	});
});

describe('experiment period comparison', () => {
	const experiment = (createdAt: number) => ({
		id: 'e1',
		site_id: 's',
		name: 'CTA',
		flag_key: 'cta',
		variants: [{ key: 'control', weight: 1 }],
		status: 'active' as const,
		active: true,
		started_at: createdAt,
		completed_at: null,
		created_at: createdAt,
	});

	it('refuses a preceding window the experiment did not exist through', () => {
		const before = { start: 1_000, end: 2_000 };
		expect(canComparePeriod(experiment(999), before)).toBe(true);
		expect(canComparePeriod(experiment(1_000), before)).toBe(true);
		// Started inside the preceding window: every variant reads zero before it, and a delta there
		// would report the start date as a result.
		expect(canComparePeriod(experiment(1_500), before)).toBe(false);
		expect(canComparePeriod(experiment(0), before)).toBe(false);
		expect(canComparePeriod(null, before)).toBe(false);
	});

	const variant = (key: string, exposures: number, conversions: number) => ({
		key,
		exposures,
		conversions,
		rate: exposures === 0 ? 0 : conversions / exposures,
		p_value: null,
		significant: false,
	});

	it('compares each variant with its own former rate, in points', () => {
		const m = variantMovements(
			[variant('control', 1000, 100), variant('blue', 1000, 150)],
			[variant('control', 1000, 120), variant('blue', 1000, 120)],
		);
		expect(movementLabel(m.get('control') as never)).toBe('−2.0 pts');
		expect(movementLabel(m.get('blue') as never)).toBe('+3.0 pts');
	});

	it('skips a variant that is new, or too thin on either side, or unmeasured', () => {
		const thin = MIN_RATE_EXPOSURES - 1;
		const m = variantMovements(
			[variant('control', 1000, 100), variant('green', 1000, 100), variant('thin', 1000, 10)],
			[variant('control', 1000, 100), variant('thin', thin, 1)],
		);
		expect(m.has('green')).toBe(false);
		expect(m.has('thin')).toBe(false);
		expect(m.has('control')).toBe(true);
		expect(variantMovements([variant('control', 1000, 100)], null).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// The wiring: one shared query, and no comparison at all under a segment.

// Two rows where the current list has three: shorter, therefore not truncated, therefore a key
// missing from it is provably absent rather than merely unranked.
let previousStats: Partial<StatsResponse> = {
	top_paths: rows(['/pricing', 100], ['/features', 100]),
};

function providers(
	ui: ReactElement,
	previous: StatsResponse | null = previousStats as StatsResponse,
) {
	return <PreviousPeriodProvider value={previous}>{ui}</PreviousPeriodProvider>;
}

function list(current: CountRow[] = rows(['/pricing', 122], ['/features', 60], ['/new', 80])) {
	return (
		<BreakdownList
			title="Top pages"
			rows={current}
			showDropped
			compare={{ current, select: (p) => p.top_paths }}
		/>
	);
}

beforeEach(() => {
	previousStats = { top_paths: rows(['/pricing', 100], ['/features', 100]) };
});

afterEach(() => {
	vi.restoreAllMocks();
	window.history.replaceState(null, '', '/');
});

describe('BreakdownList', () => {
	it('reads the provided preceding window and labels each row honestly', async () => {
		render(providers(list()));
		// /pricing 100 → 122.
		await waitFor(() => expect(screen.getByText('+22%')).toBeInTheDocument());
		// /features 100 → 60.
		expect(screen.getByText('−40%')).toBeInTheDocument();
		// /new is absent from a previous list that held everything it had, so it reads as NEW — not
		// as a percentage of zero.
		expect(screen.getByText('new')).toBeInTheDocument();
		expect(screen.queryByText('+Infinity%')).toBeNull();
	});

	it('shows a key that disappeared, rather than dropping it silently', async () => {
		previousStats = { top_paths: rows(['/pricing', 100], ['/gone', 90]) };
		render(providers(list(rows(['/pricing', 122]))));
		// The current list is shorter than the preceding one, so it holds everything there is: /gone
		// is not merely unranked, it is at zero.
		await waitFor(() => expect(screen.getByText('/gone')).toBeInTheDocument());
		expect(screen.getByText('was 90')).toBeInTheDocument();
		expect(screen.getByText('gone')).toBeInTheDocument();
	});

	it('shows no comparison at all while a segment filters the current numbers', async () => {
		// The comparison window is NOT sliced by the segment, so subtracting it from a filtered
		// current period would compare two different populations. It is not even fetched.
		render(providers(list(), null));
		await waitFor(() => expect(screen.getByText('/pricing')).toBeInTheDocument());
		expect(screen.queryByText('+22%')).toBeNull();
		expect(screen.queryByText('new')).toBeNull();
	});
});
