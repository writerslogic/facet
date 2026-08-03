// The one period-over-period badge. Every "vs previous" figure on the dashboard renders through this
// component, so sign, icon, colour and wording cannot drift between surfaces the way they had:
// KpiCard drew a pill with an arrow, the funnel drew bare coloured text, the breakdown lists drew
// nothing at all, and each had its own opinion about what "+" meant.
//
// Fixed rules, applied to every `Movement` (see lib/format.ts):
//   • sign      — "+" for a rise, "−" (U+2212) for a fall, "±0" for no change; `new`/`gone`/`entered`
//                 render as words because there is no honest number to print.
//   • icon      — up-right / down-right / minus, from the SIGN, never from the sense. A regression
//                 that rose (bounce rate, say) still points up; the colour carries good-vs-bad.
//   • colour    — the metric's sense (improvement / regression / neutral), from the palette's own
//                 --pos/--neg tokens. Never the sole carrier: the arrow and the text always agree.
//   • wording   — one tooltip sentence naming the comparison window, plus a screen-reader phrase.
//
// A missing comparison is `null`, not a zero: rendering nothing is always allowed, rendering a
// number that was not measured is not.

import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from '../lib/cn.js';
import {
	type Movement,
	movementIsFlat,
	movementLabel,
	movementSenseLabel,
	movementTitle,
} from '../lib/format.js';

/** `badge` is the pill used on cards and list rows; `text` is the bare inline form for dense tables. */
export type DeltaVariant = 'badge' | 'text';

/** True when the movement points upward (a rise, or an appearance). */
function rose(movement: Movement): boolean {
	return movement.kind === 'new' || movement.kind === 'entered' || movement.value > 0;
}

export function DeltaBadge({
	movement,
	variant = 'badge',
	size = 'md',
	className,
}: {
	/** The movement to render. `null`/`undefined` renders nothing — an unavailable comparison. */
	movement: Movement | null | undefined;
	variant?: DeltaVariant;
	/** `sm` is the compact form for breakdown rows and table cells. */
	size?: 'sm' | 'md';
	className?: string;
}): ReactElement | null {
	if (!movement) return null;

	// A change that rounds away is flat in EVERY channel: minus icon, neutral colour, "±0" text. It
	// used to be possible for a value of -1e-17 to print "±0.0 pts" beside a red down-arrow.
	const flat = movementIsFlat(movement);
	const Icon = flat ? Minus : rose(movement) ? ArrowUpRight : ArrowDownRight;

	// Tinted from the palette's own --pos/--neg rather than a fixed emerald/rose ramp, so the badge
	// belongs to the active theme and stays legible on the dark shell.
	const sense = flat ? 'neutral' : movement.sense;
	const tone =
		variant === 'badge'
			? sense === 'improvement'
				? 'badge-pos'
				: sense === 'regression'
					? 'badge-neg'
					: 'badge-neutral'
			: sense === 'improvement'
				? 'text-pos'
				: sense === 'regression'
					? 'text-neg'
					: 'text-[color:var(--faint)]';

	return (
		<span
			className={cn(
				'inline-flex items-center gap-0.5 whitespace-nowrap font-semibold tabular-nums',
				variant === 'badge' && 'rounded-full',
				variant === 'badge' && (size === 'sm' ? 'px-1.5 py-px' : 'gap-1 px-2 py-0.5'),
				size === 'sm' ? 'text-[10px]' : 'text-xs',
				tone,
				className,
			)}
			title={movementTitle(movement)}
		>
			<Icon className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'} aria-hidden="true" />
			<span>{movementLabel(movement)}</span>
			<span className="sr-only">
				{' '}
				{movementSenseLabel({ ...movement, sense })} versus the previous period
			</span>
		</span>
	);
}
