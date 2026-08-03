// The intensity ramp the two density grids on this board share (calendar heatmap, polar clock).
//
// WHY alpha over `--accent-rgb` and not a colour scale: `Retention.tsx` already settled this. A fixed
// 50..900 ramp renders as five shades of near-white on the dark shell, and a second hue scale would
// put a third colour language on a board that already spends `--c1..--c6` on categories. Alpha over
// the palette's own accent follows whichever palette is active, in both modes, from one definition.
//
// The ceiling is 0.62 for exactly the reason Retention documents: above it, ink on the tint drops
// below AA in light mode. The FLOOR is raised from Retention's 0.10 to 0.16 because these cells carry
// no text of their own — nothing has to stay legible on top of them, so the floor is set by the other
// constraint instead: band 1 must be visibly distinct from an empty cell sitting on `--hover`.
//
// Colour is never the only encoding here: every cell in both grids carries a `<title>` with its
// number, and both charts render a full sr-only table.

export const RAMP_ALPHA = [0.16, 0.28, 0.4, 0.51, 0.62] as const;

/** Fill for a band index from `bandOf` (`-1` = no activity). */
export function bandFill(band: number): string {
	if (band < 0) return 'transparent';
	const alpha = RAMP_ALPHA[Math.min(band, RAMP_ALPHA.length - 1)] ?? RAMP_ALPHA[0];
	return `rgb(var(--accent-rgb) / ${alpha})`;
}

/**
 * Cut points for the five bands, as nearest-rank order statistics of the POSITIVE values.
 *
 * Quantiles rather than an equal-width split of `[0, max]`: web traffic is heavy-tailed, so equal
 * width puts every cell except the one peak into band 1 and the grid reads as empty. Nearest-rank
 * (`floor(q × (n − 1))`) rather than an interpolated quantile, matching the convention the
 * distribution endpoint uses — every cut point is a value some day/hour actually had.
 */
export function intensityThresholds(values: readonly number[]): number[] {
	const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
	if (positive.length === 0) return [];
	return [0.2, 0.4, 0.6, 0.8].map(
		(q) => positive[Math.floor(q * (positive.length - 1))] as number,
	);
}

/** Band index for a value: `-1` when there was no activity at all, else `0..4`. */
export function bandOf(value: number, thresholds: readonly number[]): number {
	if (value <= 0) return -1;
	let band = 0;
	for (const t of thresholds) if (value > t) band++;
	return Math.min(band, RAMP_ALPHA.length - 1);
}
