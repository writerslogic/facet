// severity mapping from |z|, the derived helpers that turn detector numbers into readable copy,
// the bounded dismissal store, and the dismiss flow — dismissing one anomaly hides only that
// bucket while a different-bucket anomaly still shows.

import type { Anomaly } from '@facet/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Anomalies } from '../components/Anomalies.js';
import {
	DISMISS_MAX,
	anomalyId,
	bucketFromId,
	changePct,
	compareAnomalies,
	describeBucket,
	dismissAnomaly,
	explainZ,
	loadDismissed,
	pruneDismissed,
	restoreAnomaly,
	severityFor,
	summarize,
	summaryLine,
} from '../lib/anomaly.js';
import { clockLabel, setClockMode } from '../lib/datetime.js';

const { useAnomaliesMock } = vi.hoisted(() => ({ useAnomaliesMock: vi.fn() }));
vi.mock('../hooks/anomaly.js', () => ({ useAnomalies: useAnomaliesMock }));

const HOUR = 3_600_000;

function withQuery(ui: ReactElement): ReactElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function anomaly(bucket: number, z: number): Anomaly {
	return {
		metric: 'pageviews',
		bucket,
		value: 1,
		baseline_mean: 10,
		z,
		direction: 'drop',
		diagnosis: {
			dimension: 'device',
			value: 'mobile',
			current: 0,
			baseline_avg: 8,
		},
		summary: `Pageviews dropped in bucket ${bucket} (z=${z}).`,
	};
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('severityFor', () => {
	it('maps |z| to critical / high / moderate', () => {
		expect(severityFor(-7)).toBe('critical');
		expect(severityFor(6)).toBe('critical');
		expect(severityFor(-5)).toBe('high');
		expect(severityFor(4.5)).toBe('high');
		expect(severityFor(-3.5)).toBe('moderate');
		expect(severityFor(2)).toBe('moderate');
	});
});

describe('compareAnomalies', () => {
	it('orders most severe first, then most recent bucket', () => {
		const list = [anomaly(1000, -3.5), anomaly(2000, -7), anomaly(3000, -3.6)];
		const sorted = [...list].sort(compareAnomalies).map((a) => a.bucket);
		expect(sorted).toEqual([2000, 3000, 1000]);
	});
});

describe('changePct', () => {
	it('reports the magnitude of a drop and of a spike', () => {
		expect(changePct({ ...anomaly(0, -4), value: 1, baseline_mean: 10 })).toBe(90);
		expect(
			changePct({
				...anomaly(0, 4),
				direction: 'spike',
				value: 15,
				baseline_mean: 10,
			}),
		).toBe(50);
	});

	it('returns null rather than Infinity when the baseline is zero', () => {
		expect(changePct({ ...anomaly(0, -4), baseline_mean: 0 })).toBeNull();
	});
});

describe('explainZ', () => {
	it('restates the z-score as multiples of the usual hour-to-hour swing', () => {
		expect(explainZ(-3.42)).toContain('3.4x');
		expect(explainZ(3.42)).toContain('hour-to-hour swing');
	});
});

// An hour label is rendered in whichever clock the reader chose (lib/datetime.ts). Pinning the clock
// to UTC is what makes these literal assertions independent of the machine running them; the local
// case is asserted separately, against an independently-derived expectation.
describe('describeBucket', () => {
	beforeEach(() => setClockMode('utc'));
	afterEach(() => setClockMode('local'));

	it('labels the UTC hour window and its age', () => {
		const bucket = Date.UTC(2026, 6, 30, 14);
		const at = describeBucket(bucket, bucket + 4 * HOUR);
		expect(at.absolute).toBe('Jul 30, 14:00–15:00 UTC');
		expect(at.relative).toBe('3h ago');
		expect(at.iso).toBe('2026-07-30T14:00:00.000Z');
	});

	it('keeps both dates when the hour crosses midnight', () => {
		const bucket = Date.UTC(2026, 6, 30, 23);
		expect(describeBucket(bucket, bucket).absolute).toBe('Jul 30, 23:00 – Jul 31, 00:00 UTC');
	});

	it('renders the same hour in the reader’s own clock by default, and names it', () => {
		setClockMode('local');
		const bucket = Date.UTC(2026, 6, 30, 14);
		const at = describeBucket(bucket, bucket + HOUR);
		// The instant is unchanged — only its presentation moves — and the label always says which
		// clock it is in, so an hour is never a bare, unattributed number.
		expect(at.iso).toBe('2026-07-30T14:00:00.000Z');
		expect(at.absolute.endsWith(clockLabel())).toBe(true);
		// Derived the same way a reader's browser would, so this holds in any host timezone: it is
		// UTC's wall-clock hour shifted by the host offset, which is 14 only when the host IS UTC.
		const localHour = new Intl.DateTimeFormat(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		}).format(bucket);
		expect(at.absolute).toContain(localHour);
	});

	it('coarsens age to hours then days', () => {
		const bucket = Date.UTC(2026, 6, 30, 14);
		expect(describeBucket(bucket, bucket + HOUR).relative).toBe('within the last hour');
		expect(describeBucket(bucket, bucket + 73 * HOUR).relative).toBe('3d ago');
	});
});

describe('summarize / summaryLine', () => {
	it('counts by severity and tracks the newest bucket', () => {
		const s = summarize([anomaly(1000, -7), anomaly(5000, -5), anomaly(2000, -3)]);
		expect(s).toEqual({ total: 3, critical: 1, high: 1, moderate: 1, newest: 5000 });
	});

	it('reads as a sentence for one anomaly and for many', () => {
		const bucket = Date.UTC(2026, 6, 30, 14);
		expect(summaryLine([anomaly(bucket, -7)], bucket + 4 * HOUR)).toBe(
			'1 anomaly in this range · 1 critical · latest 3h ago',
		);
		expect(
			summaryLine([anomaly(bucket, -7), anomaly(bucket, -3)], bucket + 2 * HOUR),
		).toContain('2 anomalies in this range · 1 critical, 1 moderate');
	});

	it('discloses hidden anomalies so the count and the visible cards agree', () => {
		const bucket = Date.UTC(2026, 6, 30, 14);
		expect(summaryLine([anomaly(bucket, -7)], bucket + 4 * HOUR, 1)).toContain('1 dismissed');
	});

	it('says so when nothing is flagged', () => {
		expect(summaryLine([], Date.now())).toBe('No anomalies flagged in this range');
	});
});

describe('dismissal store', () => {
	it('parses the bucket out of an id, and rejects ids without one', () => {
		expect(bucketFromId(anomalyId('s1', anomaly(4000, -4)))).toBe(4000);
		expect(bucketFromId('s1:pageviews:')).toBeNull();
		expect(bucketFromId('nonsense')).toBeNull();
	});

	it('drops malformed and duplicate ids', () => {
		expect(
			pruneDismissed(['s:pageviews:2', 'garbage', 's:pageviews:2', 's:pageviews:1']),
		).toEqual(['s:pageviews:2', 's:pageviews:1']);
	});

	it('caps the list, evicting the oldest buckets first', () => {
		const ids = Array.from({ length: DISMISS_MAX + 25 }, (_, i) => `s:pageviews:${i}`);
		const pruned = pruneDismissed(ids);
		expect(pruned).toHaveLength(DISMISS_MAX);
		expect(pruned[0]).toBe(`s:pageviews:${DISMISS_MAX + 24}`);
		expect(pruned).not.toContain('s:pageviews:0');
	});

	it('loadDismissed writes the pruned list back so storage cannot grow unbounded', () => {
		const ids = ['garbage', ...Array.from({ length: DISMISS_MAX + 5 }, (_, i) => `s:pv:${i}`)];
		localStorage.setItem('facet.dismissedAnomalies', JSON.stringify(ids));
		expect(loadDismissed().size).toBe(DISMISS_MAX);
		const stored = JSON.parse(
			localStorage.getItem('facet.dismissedAnomalies') as string,
		) as string[];
		expect(stored).toHaveLength(DISMISS_MAX);
		expect(stored).not.toContain('garbage');
	});

	it('survives a corrupt storage value', () => {
		localStorage.setItem('facet.dismissedAnomalies', '{not json');
		expect(loadDismissed().size).toBe(0);
	});

	it('dismiss then restore leaves nothing behind', () => {
		const id = anomalyId('s1', anomaly(9000, -4));
		dismissAnomaly(id);
		expect(loadDismissed().has(id)).toBe(true);
		restoreAnomaly(id);
		expect(loadDismissed().has(id)).toBe(false);
	});
});

describe('Anomalies severity + dismiss', () => {
	it('renders a labeled severity badge', () => {
		useAnomaliesMock.mockReturnValue({
			data: { anomalies: [anomaly(1000, -7)] },
		});
		render(withQuery(<Anomalies apiKey="clk_x" siteId="s1" range={{ start: 0, end: 1 }} />));
		expect(screen.getByText('Critical')).toBeInTheDocument();
	});

	it('dismisses one bucket while a different bucket still shows', () => {
		useAnomaliesMock.mockReturnValue({
			data: { anomalies: [anomaly(1000, -7), anomaly(2000, -5)] },
		});
		render(withQuery(<Anomalies apiKey="clk_x" siteId="s1" range={{ start: 0, end: 1 }} />));
		expect(screen.getByText(/bucket 1000/)).toBeInTheDocument();
		expect(screen.getByText(/bucket 2000/)).toBeInTheDocument();

		const [firstDismiss] = screen.getAllByRole('button', {
			name: 'Dismiss anomaly',
		});
		fireEvent.click(firstDismiss as HTMLElement);

		expect(screen.queryByText(/bucket 1000/)).not.toBeInTheDocument();
		expect(screen.getByText(/bucket 2000/)).toBeInTheDocument();
	});

	it('persists a dismissal across a remount', () => {
		useAnomaliesMock.mockReturnValue({
			data: { anomalies: [anomaly(1000, -7)] },
		});
		const first = render(
			withQuery(<Anomalies apiKey="clk_x" siteId="s1" range={{ start: 0, end: 1 }} />),
		);
		fireEvent.click(screen.getByRole('button', { name: 'Dismiss anomaly' }));
		first.unmount();

		render(withQuery(<Anomalies apiKey="clk_x" siteId="s1" range={{ start: 0, end: 1 }} />));
		expect(screen.queryByText(/bucket 1000/)).not.toBeInTheDocument();
		expect(screen.getByText(/Anomaly dismissed/)).toBeInTheDocument();
	});
});
