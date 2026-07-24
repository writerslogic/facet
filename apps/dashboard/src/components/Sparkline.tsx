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
}: {
	values: number[];
	width?: number;
	height?: number;
	stroke?: string;
	className?: string;
	fill?: boolean;
	/** A bolder line + stronger area fill, for the large drill-down chart in an expanded KPI tile. */
	prominent?: boolean;
}): ReactElement | null {
	const gradId = useId();
	if (values.length < 2) return null;
	const max = Math.max(...values);
	const min = Math.min(...values);
	const span = max - min || 1;
	const step = width / (values.length - 1);
	const coords = values.map((v, i) => {
		const x = i * step;
		const y = height - ((v - min) / span) * (height - 2) - 1;
		return [x, y] as const;
	});
	const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
	const area = `${coords[0]?.[0].toFixed(1)},${height} ${line} ${coords[coords.length - 1]?.[0].toFixed(1)},${height}`;
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
				stroke={stroke}
				strokeWidth={prominent ? 2.5 : responsive ? 1 : 1.5}
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect={responsive ? 'non-scaling-stroke' : undefined}
			/>
		</svg>
	);
}
