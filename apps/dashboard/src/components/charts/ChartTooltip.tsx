// The one tooltip every chart uses.
//
// Deliberately `aria-hidden` and `data-chrome`: it is a pointer affordance, not content. Charts owe
// screen readers a real text equivalent (the sr-only tables next to the Sankey, WorldMap and
// retention curve), and a tooltip that also announced itself would spam a live region on every
// pixel of pointer movement while still leaving keyboard users with nothing. `data-chrome` keeps it
// out of Cmd+A, so copying a chart's data does not drag a floating label in with it.

import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

/** Distance from the pointer, so the cursor never sits on top of the label it summoned. */
const OFFSET = 14;

export function ChartTooltip({
	x,
	y,
	containerWidth,
	containerHeight,
	children,
	className,
}: {
	/** Pointer position in container-relative pixels (what `useHoverTarget` reports). */
	x: number;
	y: number;
	containerWidth: number;
	containerHeight: number;
	children: ReactNode;
	className?: string;
}): ReactElement {
	// Flip toward the inside when the pointer nears an edge, so the tooltip never leaves the tile.
	// Measuring the tooltip itself would cost a layout read per frame; a conservative estimate that
	// flips early is smoother and indistinguishable in practice.
	const flipX = x > containerWidth - 180;
	const flipY = y > containerHeight - 90;

	return (
		<div
			aria-hidden="true"
			data-chrome
			className={cn(
				'surface pointer-events-none absolute z-30 max-w-[220px] rounded-lg px-2.5 py-2 shadow-float',
				'text-[color:var(--ink)] text-xs leading-relaxed',
				className,
			)}
			style={{
				left: flipX ? undefined : x + OFFSET,
				right: flipX ? containerWidth - x + OFFSET : undefined,
				top: flipY ? undefined : y + OFFSET,
				bottom: flipY ? containerHeight - y + OFFSET : undefined,
			}}
		>
			{children}
		</div>
	);
}

/** A label/value line inside a tooltip, with the optional colour swatch charts use to tie a row to a series. */
export function TooltipRow({
	label,
	value,
	swatch,
}: {
	label: string;
	value: ReactNode;
	/** Any CSS colour — pass the series' own hue so the row reads as that series. */
	swatch?: string;
}): ReactElement {
	return (
		<div className="flex items-baseline gap-2">
			{swatch ? (
				<span
					className="inline-block size-2 shrink-0 rounded-[2px]"
					style={{ backgroundColor: swatch }}
				/>
			) : null}
			<span className="min-w-0 truncate text-[color:var(--muted)]">{label}</span>
			<span className="ml-auto font-semibold tabular-nums">{value}</span>
		</div>
	);
}
