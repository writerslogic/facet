// Shared surface primitives so every panel shares one card style, spacing, and heading treatment.

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export function Card({
	className,
	children,
	style,
}: {
	className?: string;
	children: ReactNode;
	/** Inline style, used to publish per-card CSS variables (e.g. a breakdown list's `--bar` hue). */
	style?: CSSProperties;
}): ReactElement {
	return (
		<section style={style} className={cn('surface rounded-2xl p-5 shadow-card', className)}>
			{children}
		</section>
	);
}

export function CardHeading({
	children,
	action,
	level = 3,
}: {
	children: ReactNode;
	action?: ReactNode;
	/**
	 * Heading depth. A card nested under a tab's own section heading is an h3 (the default); a card
	 * that IS a top-level section of its tab must be an h2, or it reads as a level skipped straight
	 * from the view's h1 — which is exactly what the Realtime breakdowns were doing.
	 */
	level?: 2 | 3;
}): ReactElement {
	const Heading = level === 2 ? 'h2' : 'h3';
	return (
		<div className="mb-4 flex items-center justify-between gap-3">
			<Heading className="text-[13px] font-semibold uppercase tracking-wide text-[color:var(--muted)]">
				{children}
			</Heading>
			{action}
		</div>
	);
}
