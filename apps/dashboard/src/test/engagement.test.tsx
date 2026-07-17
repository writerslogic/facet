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
