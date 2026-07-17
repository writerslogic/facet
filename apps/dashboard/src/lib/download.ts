// Authed CSV/JSON export: fetches /api/stats/export with the bearer key, then triggers a browser
// download from the response blob (the fetch carries auth, so a plain link would not).

import type { Range } from '../state.js';

export type ExportKind = 'series' | 'breakdown';
export type ExportFormat = 'csv' | 'json';

export interface ExportParams {
	siteId: string;
	range: Range;
	kind: ExportKind;
	format: ExportFormat;
	/** Dimension for a breakdown export (e.g. 'path', 'referrer'). */
	dimension?: string;
	/** Optional hostname filter to preserve the active view. */
	hostname?: string;
	interval?: 'hour' | 'day';
	limit?: number;
}

/** Build the export request path (querystring), preserving site + range + optional filters. */
export function exportPath(params: ExportParams): string {
	const qs = new URLSearchParams({
		site_id: params.siteId,
		start: String(params.range.start),
		end: String(params.range.end),
		kind: params.kind,
		format: params.format,
	});
	if (params.dimension) qs.set('dimension', params.dimension);
	if (params.hostname) qs.set('hostname', params.hostname);
	if (params.interval) qs.set('interval', params.interval);
	if (params.limit != null) qs.set('limit', String(params.limit));
	return `/api/stats/export?${qs.toString()}`;
}

function filenameFor(params: ExportParams): string {
	const day = new Date(params.range.end).toISOString().slice(0, 10);
	const what = params.kind === 'breakdown' ? (params.dimension ?? 'breakdown') : 'series';
	return `facet-${what}-${day}.${params.format}`;
}

/**
 * Download an export as a file. Fetches with the bearer key, materializes a blob, and clicks a
 * transient object-URL anchor. Throws on a non-2xx response so callers can surface an error.
 */
export async function downloadExport(apiKey: string, params: ExportParams): Promise<void> {
	const res = await fetch(exportPath(params), {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? 'export_failed');
	}
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	try {
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filenameFor(params);
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}
