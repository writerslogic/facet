// engagement KPI cards format their four metrics, and the channels panel renders one row
// per channel.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChannelsPanel } from '../components/ChannelsPanel.js';
import { EngagementCards } from '../components/EngagementCards.js';

describe('EngagementCards', () => {
	it('formats sessions, bounce rate, pages/session, and avg duration', () => {
		render(
			<EngagementCards
				engagement={{
					sessions: 1234,
					bounce_rate: 0.31,
					pages_per_session: 2.7,
					avg_duration_ms: 95_000,
				}}
			/>,
		);
		expect(screen.getByText('1,234')).toBeInTheDocument();
		expect(screen.getByText('31%')).toBeInTheDocument();
		expect(screen.getByText('2.7')).toBeInTheDocument();
		expect(screen.getByText('1:35')).toBeInTheDocument();
	});

	it('reports the bounce rate delta in percentage points, not a relative percent of a percent', () => {
		render(
			<EngagementCards
				engagement={{
					sessions: 1234,
					bounce_rate: 0.4,
					pages_per_session: 2.7,
					avg_duration_ms: 95_000,
				}}
				compare={{
					sessions: 1000,
					bounce_rate: 0.32,
					pages_per_session: 2.5,
					avg_duration_ms: 90_000,
				}}
			/>,
		);
		// 0.32 -> 0.40 is a real +8.0-point regression. Routed through the count-shaped computeDelta
		// this would render as "+25%" (0.08 / 0.32) — the classic funnel misread lib/format.ts warns
		// against — instead of the correct points-based movement.
		expect(screen.getByText('+8.0 pts')).toBeInTheDocument();
		expect(screen.queryByText('+25%')).not.toBeInTheDocument();
	});
});

describe('ChannelsPanel', () => {
	it('renders one row per channel', () => {
		render(
			<ChannelsPanel
				channels={[
					{ key: 'organic', count: 20 },
					{ key: 'referral', count: 8 },
				]}
			/>,
		);
		expect(screen.getByText('organic')).toBeInTheDocument();
		expect(screen.getByText('referral')).toBeInTheDocument();
	});
});
