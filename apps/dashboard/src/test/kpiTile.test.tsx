// KpiTile: the compact metric readout, and its expanded drill-down which reveals an Avg/Peak/Low strip
// over a full-height chart. Asserts the value renders in both modes and the detail strip only when expanded.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KpiTile } from '../components/BentoTile.js';

const SPARK = [10, 40, 20, 87, 0, 30]; // peak 87, low 0

describe('KpiTile', () => {
	it('compact mode shows the value without the Avg/Peak/Low strip', () => {
		render(<KpiTile label="Pageviews" value={744} spark={SPARK} />);
		expect(screen.getByText('744')).toBeInTheDocument();
		expect(screen.queryByText('Peak')).toBeNull();
	});

	// The tile used to print the magnitude unsigned and let the arrow carry direction, which is not
	// what any other delta on the dashboard does. It now renders the shared DeltaBadge: signed text,
	// arrow AND colour, identical everywhere (see components/Delta.tsx).
	it('shows the delta signed, through the shared badge', () => {
		render(
			<KpiTile
				label="Visitors"
				value={100}
				deltaPct={-12}
				deltaSense="regression"
				spark={SPARK}
			/>,
		);
		expect(screen.getByText('−12%')).toBeInTheDocument();
		// A real minus sign (U+2212), never a hyphen, and never an unsigned magnitude.
		expect(screen.queryByText('-12%')).toBeNull();
		expect(screen.queryByText('12%')).toBeNull();
	});

	it('expanded mode reveals the Avg/Peak/Low detail from the series', () => {
		render(<KpiTile label="Pageviews" value={744} spark={SPARK} expanded />);
		expect(screen.getByText('744')).toBeInTheDocument();
		expect(screen.getByText('Avg')).toBeInTheDocument();
		expect(screen.getByText('Peak')).toBeInTheDocument();
		expect(screen.getByText('Low')).toBeInTheDocument();
		expect(screen.getByText('87')).toBeInTheDocument(); // peak = max(SPARK)
	});
});
