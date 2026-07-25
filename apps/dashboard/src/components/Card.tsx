// Shared surface primitives so every panel shares one card style, spacing, and heading treatment.

import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export function Card({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}): ReactElement {
	return (
		<section
			className={cn(
				'rounded-2xl border border-[color:rgb(var(--border))] bg-[var(--panel)] p-5 shadow-card ring-1 ring-[color:rgb(var(--border))]',
				className,
			)}
		>
			{children}
		</section>
	);
}

export function CardHeading({
	children,
	action,
}: {
	children: ReactNode;
	action?: ReactNode;
}): ReactElement {
	return (
		<div className="mb-4 flex items-center justify-between gap-3">
			<h3 className="text-[13px] font-semibold uppercase tracking-wide text-[color:var(--muted)]">
				{children}
			</h3>
			{action}
		</div>
	);
}
