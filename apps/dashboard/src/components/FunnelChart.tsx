// Funnel visualization: pure CSS/SVG horizontal bars (no chart library, to keep the bundle small).
// Each step's bar width is proportional to the first step's count; drop-off vs. the previous step
// is shown per row, and the overall completion rate is highlighted.

import type { FunnelReportResult } from '@facet/shared';
import type { ReactElement } from 'react';
import { formatNumber, formatPercent } from '../lib/format.js';

export function FunnelChart({
	report,
}: {
	report: FunnelReportResult;
}): ReactElement {
	const first = report.steps[0]?.count ?? 0;

	return (
		<section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
			<div className="mb-4 flex items-baseline justify-between">
				<h3 className="text-sm font-medium text-neutral-500">Funnel</h3>
				<span className="text-sm text-neutral-600">
					Overall{' '}
					<span className="font-semibold text-neutral-900 tabular-nums">
						{formatPercent(report.overall_rate)}
					</span>
				</span>
			</div>
			{report.steps.length === 0 ? (
				<p className="py-6 text-center text-sm text-neutral-400">No data yet</p>
			) : (
				<ol className="space-y-2">
					{report.steps.map((step) => {
						const width = first > 0 ? (step.count / first) * 100 : 0;
						const prev = report.steps[step.index - 1]?.count;
						const dropOff =
							prev !== undefined && prev > 0 ? 1 - step.count / prev : undefined;
						return (
							<li key={step.index}>
								<div className="mb-1 flex items-center justify-between text-sm">
									<span className="truncate text-neutral-800">
										<span className="mr-2 text-neutral-400 tabular-nums">
											{step.index + 1}.
										</span>
										{step.match_value}
									</span>
									<span className="pl-3 text-neutral-600 tabular-nums">
										{formatNumber(step.count)}
										{dropOff !== undefined && dropOff > 0 ? (
											<span className="ml-2 text-xs text-red-500">
												-{formatPercent(dropOff)}
											</span>
										) : null}
									</span>
								</div>
								<div className="h-2.5 w-full overflow-hidden rounded-full bg-neutral-100">
									<div
										className="h-full rounded-full bg-accent-500"
										style={{ width: `${width}%` }}
										data-testid="funnel-bar"
									/>
								</div>
							</li>
						);
					})}
				</ol>
			)}
		</section>
	);
}
