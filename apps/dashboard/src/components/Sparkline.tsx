// Tiny inline SVG sparkline — cheap, no chart lib. Purely decorative (aria-hidden). Fixed-size by
// default (96×28); pass `className` to make it fill its container (viewBox-scaled), and `fill` to add
// a gradient area under the line for a fuller "alive" look in bento tiles.

import { type ReactElement, useId } from 'react';
import { cn } from '../lib/cn.js';

export function Sparkline({
	values,
	width = 96,
	height = 28,
	stroke = '#6366f1',
	className,
	fill = false,
	prominent = false,
	marker = false,
	prism = false,
}: {
	values: number[];
	width?: number;
	height?: number;
	stroke?: string;
	className?: string;
	fill?: boolean;
	/** A bolder line + stronger area fill, for the large drill-down chart in an expanded KPI tile. */
	prominent?: boolean;
	/** A focal dot at the latest value — the "you are here" point that makes the spark read as live. */
	marker?: boolean;
	/** Stroke the line + marker with the prismatic sweep (indigo→violet→fuchsia) instead of a flat colour. */
	prism?: boolean;
}): ReactElement | null {
	const gradId = useId();
	const strokeId = useId();
	const strokeRef = prism ? `url(#${strokeId})` : stroke;
	if (values.length < 2) return null;
	const max = Math.max(...values);
	const min = Math.min(...values);
	// A constant series has no span to normalise against. Falling back to span = 1 put every point at
	// (v - min) / 1 = 0, i.e. a flat line glued to the BOTTOM edge — which reads as "this metric is at
	// zero" when it may be steady at any value. Centre it instead: flat is flat, not floored.
	const flat = max === min;
	const span = max - min || 1;
	const step = width / (values.length - 1);
	const coords = values.map((v, i) => {
		const x = i * step;
		const y = flat ? height / 2 : height - ((v - min) / span) * (height - 2) - 1;
		return [x, y] as const;
	});
	const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
	const area = `${coords[0]?.[0].toFixed(1)},${height} ${line} ${coords[coords.length - 1]?.[0].toFixed(1)},${height}`;
	const last = coords[coords.length - 1];
	const responsive = Boolean(className);

	return (
		<svg
			width={responsive ? '100%' : width}
			height={responsive ? '100%' : height}
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio={responsive ? 'none' : 'xMidYMid meet'}
			className={cn('overflow-visible', className)}
			aria-hidden="true"
			focusable="false"
		>
			{prism ? (
				<defs>
					<linearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
						<stop offset="0%" stopColor="var(--c1)" />
						<stop offset="50%" stopColor="var(--c2)" />
						<stop offset="100%" stopColor="var(--c3)" />
					</linearGradient>
				</defs>
			) : null}
			{fill ? (
				<>
					<defs>
						<linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
							<stop
								offset="0%"
								stopColor={stroke}
								stopOpacity={prominent ? '0.35' : '0.22'}
							/>
							<stop offset="100%" stopColor={stroke} stopOpacity="0" />
						</linearGradient>
					</defs>
					<polygon points={area} fill={`url(#${gradId})`} stroke="none" />
				</>
			) : null}
			<polyline
				points={line}
				fill="none"
				stroke={strokeRef}
				strokeWidth={prominent ? 2.5 : responsive ? 1.4 : 1.5}
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect={responsive ? 'non-scaling-stroke' : undefined}
			/>
			{marker && last ? (
				// A faceted diamond (rotated square) rather than a dot — the "cut gem" motif on the live value.
				<path
					d={(() => {
						const [x, y] = last;
						const r = prominent ? 3.2 : 2.6;
						return `M${x},${y - r} L${x + r},${y} L${x},${y + r} L${x - r},${y} Z`;
					})()}
					fill={strokeRef}
					stroke="white"
					strokeWidth={prominent ? 2 : 1.5}
					strokeLinejoin="round"
					vectorEffect={responsive ? 'non-scaling-stroke' : undefined}
				/>
			) : null}
		</svg>
	);
}
