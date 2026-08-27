// `facet import`: backfill history from another analytics tool into POST /api/import.
//
// The file is event-level by necessity: a visitor id, a timestamp and a path per row. Plausible's and
// GA4's default exports are pre-aggregated (sessions/day, top pages) and carry no per-visitor rows, so
// they cannot become events — convert an event-level export to the CSV columns below instead.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { IMPORT_MAX_DAYS, IMPORT_MAX_EVENTS, type ImportEventInput } from '@facet/shared';
import pc from 'picocolors';
import {
	type FetchJson,
	UsageError,
	adminClient,
	requireUuid,
	resolveAdminToken,
	resolveHost,
} from '../admin.js';
import { fetchJson, printError } from '../util.js';

type Format = 'json' | 'ndjson' | 'csv';

interface ImportResponse {
	imported: number;
	skipped: number;
	duplicates?: number;
	days: string[];
	dry_run?: boolean;
	note: string;
}

const CSV_COLUMNS = [
	'timestamp',
	'visitor_id',
	'hostname',
	'path',
	'referrer',
	'name',
	'country',
	'user_agent',
	'utm_source',
	'utm_medium',
	'utm_campaign',
] as const;

function detectFormat(file: string): Format {
	if (file.endsWith('.csv')) return 'csv';
	if (file.endsWith('.ndjson') || file.endsWith('.jsonl')) return 'ndjson';
	return 'json';
}

/** Epoch milliseconds from either a numeric epoch (ms or seconds) or an ISO 8601 string. Seconds are
 * distinguished by magnitude: any plausible ms timestamp since 2001 exceeds 1e12. */
function toEpochMs(raw: unknown, where: string): number {
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
	}
	if (typeof raw === 'string' && raw !== '') {
		if (/^\d+$/.test(raw)) return toEpochMs(Number(raw), where);
		const parsed = Date.parse(raw);
		if (!Number.isNaN(parsed)) return parsed;
	}
	throw new UsageError(
		`${where}: "timestamp" is not an epoch or an ISO 8601 date (got ${JSON.stringify(raw)}).`,
	);
}

function requireField(record: Record<string, unknown>, key: string, where: string): string {
	const value = record[key];
	if (typeof value !== 'string' || value === '') {
		throw new UsageError(`${where}: missing required field "${key}".`);
	}
	return value;
}

function optionalField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Map one source record to the wire shape. Only the fields the server accepts survive, so an export
 * carrying extra columns (a raw IP, an email) cannot smuggle them into the request body. */
function toEvent(record: Record<string, unknown>, where: string): ImportEventInput {
	const utm = {
		source: optionalField(record, 'utm_source'),
		medium: optionalField(record, 'utm_medium'),
		campaign: optionalField(record, 'utm_campaign'),
	};
	const props = record.props;
	return {
		timestamp: toEpochMs(record.timestamp, where),
		visitor_id: requireField(record, 'visitor_id', where),
		hostname: requireField(record, 'hostname', where),
		path: requireField(record, 'path', where),
		referrer: optionalField(record, 'referrer'),
		name: optionalField(record, 'name'),
		country: optionalField(record, 'country')?.toUpperCase(),
		user_agent: optionalField(record, 'user_agent'),
		utm: utm.source || utm.medium || utm.campaign ? utm : undefined,
		props:
			props && typeof props === 'object' ? (props as ImportEventInput['props']) : undefined,
	};
}

/** RFC 4180 field splitter: handles quoted fields, embedded commas/newlines, and doubled quotes. */
function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += ch;
			continue;
		}
		if (ch === '"') quoted = true;
		else if (ch === ',') {
			row.push(field);
			field = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else field += ch;
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	const header = rows.shift();
	if (!header) throw new UsageError('CSV file is empty.');
	return rows
		.filter((r) => r.some((cell) => cell.trim() !== ''))
		.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

function parseRecords(text: string, format: Format): Record<string, unknown>[] {
	if (format === 'csv') return parseCsv(text);
	if (format === 'ndjson') {
		return text
			.split('\n')
			.map((line, i) => ({ line: i + 1, text: line.trim() }))
			.filter((l) => l.text !== '')
			.map((l) => {
				try {
					return JSON.parse(l.text) as Record<string, unknown>;
				} catch {
					throw new UsageError(`line ${l.line}: not valid JSON.`);
				}
			});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new UsageError('file is not valid JSON.');
	}
	if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
	const events = (parsed as { events?: unknown }).events;
	if (Array.isArray(events)) return events as Record<string, unknown>[];
	throw new UsageError(
		'JSON file must be an array of events, or an object with an "events" array.',
	);
}

/** Split into request-sized batches, bounded on BOTH axes the server enforces: event count and the
 * number of distinct UTC days a single request may span. */
export function batchEvents(events: ImportEventInput[]): ImportEventInput[][] {
	const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
	const batches: ImportEventInput[][] = [];
	let current: ImportEventInput[] = [];
	let days = new Set<string>();
	for (const event of ordered) {
		const day = new Date(event.timestamp).toISOString().slice(0, 10);
		const wouldAddDay = !days.has(day);
		if (
			current.length >= IMPORT_MAX_EVENTS ||
			(wouldAddDay && days.size >= IMPORT_MAX_DAYS && current.length > 0)
		) {
			batches.push(current);
			current = [];
			days = new Set<string>();
		}
		current.push(event);
		days.add(day);
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

export async function runImport(args: string[], fetchImpl: FetchJson = fetchJson): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			host: { type: 'string' },
			'admin-token': { type: 'string' },
			site: { type: 'string' },
			file: { type: 'string' },
			format: { type: 'string' },
			'dry-run': { type: 'boolean' },
			json: { type: 'boolean' },
		},
		allowPositionals: false,
	});

	try {
		const host = resolveHost(values.host);
		const token = resolveAdminToken(values['admin-token']);
		const site = requireUuid('site', values.site);
		const file = values.file;
		if (!file) throw new UsageError('Missing required option: --file <path>.');
		const format = (values.format ?? detectFormat(file)) as Format;
		if (format !== 'json' && format !== 'ndjson' && format !== 'csv') {
			throw new UsageError(`--format must be one of: json, ndjson, csv (got: ${format}).`);
		}

		const text = await readFile(file, 'utf8');
		const records = parseRecords(text, format);
		if (records.length === 0) throw new UsageError(`${file} contains no events.`);
		const events = records.map((r, i) => toEvent(r, `${file} record ${i + 1}`));
		const batches = batchEvents(events);

		const api = adminClient(host, token, fetchImpl);
		let imported = 0;
		let skipped = 0;
		let duplicates = 0;
		const days = new Set<string>();
		let note = '';
		for (const [i, batch] of batches.entries()) {
			const res = await api.post<ImportResponse>('/api/import', {
				site_id: site,
				events: batch,
				dry_run: values['dry-run'] === true,
			});
			imported += res.imported;
			skipped += res.skipped;
			duplicates += res.duplicates ?? 0;
			for (const d of res.days) days.add(d);
			note = res.note;
			if (!values.json) {
				process.stdout.write(
					`  batch ${i + 1}/${batches.length}: ${res.imported} imported, ${res.skipped} skipped\n`,
				);
			}
		}

		const summary = {
			events: events.length,
			imported,
			skipped,
			duplicates,
			days: [...days].sort(),
			dry_run: values['dry-run'] === true,
			note,
		};
		if (values.json) {
			process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
			return 0;
		}
		process.stdout.write(
			`${pc.bold(values['dry-run'] ? 'Dry run' : 'Imported')}: ${imported} of ${events.length} event(s) across ${summary.days.length} day(s)`,
		);
		const dropped = [
			skipped > 0 ? `${skipped} bot-filtered` : '',
			duplicates > 0 ? `${duplicates} duplicate` : '',
		].filter(Boolean);
		process.stdout.write(dropped.length > 0 ? `, ${dropped.join(', ')}\n` : '\n');
		process.stdout.write(`${pc.dim(note)}\n`);
		return 0;
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

/** The CSV header this command accepts, for `--help` and the docs to stay in step with the parser. */
export const IMPORT_CSV_HEADER = CSV_COLUMNS.join(',');
