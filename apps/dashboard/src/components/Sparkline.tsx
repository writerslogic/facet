// Tiny inline SVG sparkline — cheap, no chart lib. Purely decorative (aria-hidden).

import type { ReactElement } from 'react';

export function Sparkline({
	values,
	width = 96,
	height = 28,
	stroke = '#6366f1',
}: {
	values: number[];
	width?: number;
	height?: number;
	stroke?: string;
}): ReactElement | null {
	if (values.length < 2) return null;
	const max = Math.max(...values);
	const min = Math.min(...values);
	const span = max - min || 1;
	const step = width / (values.length - 1);
	const points = values
		.map((v, i) => {
			const x = i * step;
			const y = height - ((v - min) / span) * (height - 2) - 1;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(' ');

	return (
		<svg
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			className="overflow-visible"
			aria-hidden="true"
			focusable="false"
		>
			<polyline
				points={points}
				fill="none"
				stroke={stroke}
				strokeWidth={1.5}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
