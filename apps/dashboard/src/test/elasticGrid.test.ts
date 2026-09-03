// The elastic-grid packer places tiles explicitly so the board knows which tracks each spans. These
// tests lock the desktop (6-col) and mobile (2-col) packing: the shipped layout packs with no overlaps
// and no dead cells (gap-fill), wide tiles span the grid, and a narrow grid clamps oversized tiles.

import { describe, expect, it } from 'vitest';
import { columnsForWidth, fitVisibleCount, packSlots, trackTemplate } from '../lib/elasticGrid.js';
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
	it('packs the shipped layout on the desktop grid with no overlaps and no dead cells', () => {
		const { placements, rowCount } = packSlots(DEFAULT_LAYOUT, 6);
		expect(placements).toHaveLength(DEFAULT_LAYOUT.length);
		expect(hasOverlap(placements)).toBe(false);
		// Every tile stays inside the 6 columns.
		for (const p of placements) {
			expect(p.colStart).toBeGreaterThanOrEqual(1);
			expect(p.colStart + p.colSpan - 1).toBeLessThanOrEqual(6);
		}
		// Gap-fill guarantees the packed grid has NO dead space: every cell of the rowCount×6 grid is
		// covered by exactly one tile.
		const covered = new Set<string>();
		for (const p of placements) {
			for (let r = p.rowStart; r < p.rowStart + p.rowSpan; r++) {
				for (let c = p.colStart; c < p.colStart + p.colSpan; c++) {
					covered.add(`${r}:${c}`);
				}
			}
		}
		expect(covered.size).toBe(rowCount * 6);
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

	it('keeps the hero and KPI stack intact on the intermediate four-column grid', () => {
		const { placements, rowCount } = packSlots(DEFAULT_LAYOUT, 4);
		expect(hasOverlap(placements)).toBe(false);
		expect(placements[0]).toEqual({ colStart: 1, colSpan: 3, rowStart: 1, rowSpan: 3 });
		expect(placements.slice(1, 4).map((placement) => placement.colStart)).toEqual([4, 4, 4]);
		expect(rowCount).toBe(5);
	});

	it('selects two, four, and six columns from minimum usable widths', () => {
		expect(columnsForWidth(390)).toBe(2);
		expect(columnsForWidth(768)).toBe(4);
		expect(columnsForWidth(1120)).toBe(4);
		expect(columnsForWidth(1440)).toBe(6);
	});

	it('counts only complete leading placements within a fit cap', () => {
		const { placements } = packSlots(DEFAULT_LAYOUT, 4);
		expect(fitVisibleCount(placements, 3)).toBe(4);
		expect(fitVisibleCount(placements, 5)).toBe(DEFAULT_LAYOUT.length);
	});
});

describe('trackTemplate', () => {
	it('renders fr weights as collapsible minmax tracks', () => {
		expect(trackTemplate([1, 2.2, 0.5])).toBe(
			'minmax(0, 1fr) minmax(0, 2.2fr) minmax(0, 0.5fr)',
		);
	});
});
