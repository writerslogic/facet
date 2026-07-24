// The elastic-grid packer places tiles explicitly so the board knows which tracks each spans. These
// tests lock the desktop (6-col) and mobile (2-col) packing: the shipped layout fills exactly 6 rows
// with no overlaps, wide tiles span the grid, and a narrow grid clamps oversized tiles to full width.

import { describe, expect, it } from 'vitest';
import { packSlots, trackTemplate } from '../lib/elasticGrid.js';
import { DEFAULT_LAYOUT, type Slot } from '../lib/tiles.js';

/** True if any two placements share a cell — the packer must never overlap tiles. */
function hasOverlap(placements: ReturnType<typeof packSlots>['placements']): boolean {
	const seen = new Set<string>();
	for (const p of placements) {
		for (let r = p.rowStart; r < p.rowStart + p.rowSpan; r++) {
			for (let c = p.colStart; c < p.colStart + p.colSpan; c++) {
				const cell = `${r}:${c}`;
				if (seen.has(cell)) return true;
				seen.add(cell);
			}
		}
	}
	return false;
}

describe('packSlots', () => {
	it('packs the shipped layout into exactly 6 rows on the desktop grid, without overlaps', () => {
		const { placements, rowCount } = packSlots(DEFAULT_LAYOUT, 6);
		expect(placements).toHaveLength(DEFAULT_LAYOUT.length);
		expect(rowCount).toBe(6);
		expect(hasOverlap(placements)).toBe(false);
		// Every tile stays inside the 6 columns.
		for (const p of placements) {
			expect(p.colStart).toBeGreaterThanOrEqual(1);
			expect(p.colStart + p.colSpan - 1).toBeLessThanOrEqual(6);
		}
		// The hero traffic tile anchors the top-left at its full 4x3 footprint.
		expect(placements[0]).toEqual({
			colStart: 1,
			colSpan: 4,
			rowStart: 1,
			rowSpan: 3,
		});
	});

	it('clamps an oversized tile to the grid width on a narrow (2-col) grid', () => {
		const wide: Slot[] = [{ uid: 'w', tileId: 'traffic', size: 'wide' }];
		const { placements } = packSlots(wide, 2);
		expect(placements[0]?.colSpan).toBe(2); // wide wants 6 cols, clamps to 2
		expect(hasOverlap(placements)).toBe(false);
	});

	it('spans a wide tile across the full desktop grid', () => {
		const wide: Slot[] = [{ uid: 'w', tileId: 'traffic', size: 'wide' }];
		const { placements } = packSlots(wide, 6);
		expect(placements[0]?.colSpan).toBe(6);
	});

	it('packs into more rows on the narrow (2-col) grid — the board shrinks them to fit', () => {
		const { rowCount } = packSlots(DEFAULT_LAYOUT, 2);
		expect(rowCount).toBeGreaterThan(6);
	});
});

describe('trackTemplate', () => {
	it('renders fr weights as collapsible minmax tracks', () => {
		expect(trackTemplate([1, 2.2, 0.5])).toBe(
			'minmax(0, 1fr) minmax(0, 2.2fr) minmax(0, 0.5fr)',
		);
	});
});
