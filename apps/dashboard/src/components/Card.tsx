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
				'rounded-2xl border border-neutral-200/80 bg-white p-5 shadow-sm ring-1 ring-neutral-900/[0.02]',
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
			<h3 className="text-[13px] font-semibold uppercase tracking-wide text-neutral-500">
				{children}
			</h3>
			{action}
		</div>
	);
}
