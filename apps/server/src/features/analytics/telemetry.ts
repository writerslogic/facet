import { createLogger } from '../../lib/log.js';

const statsLog = createLogger({ feature: 'analytics' });

/** Emit only aggregate query cost/timing data. Site ids, filters, dimensions, and query text are
 * intentionally absent so enabling this telemetry cannot create a parallel analytics dataset. */
export function recordStatsRead(
	endpoint: string,
	metrics: {
		durationMs: number;
		statements: number;
		d1DurationMs?: number;
		rowsRead?: number;
	},
): void {
	statsLog.info('stats_read', {
		endpoint,
		duration_ms: Math.round(metrics.durationMs * 100) / 100,
		d1_duration_ms:
			metrics.d1DurationMs === undefined
				? undefined
				: Math.round(metrics.d1DurationMs * 100) / 100,
		rows_read: metrics.rowsRead,
		rows_read_observed: metrics.rowsRead !== undefined,
		statements: metrics.statements,
	});
}
