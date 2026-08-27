// `facet import`: file parsing, the dual-axis batching the server's per-request bounds require, and
// the field mapping that keeps unexpected export columns out of the request body.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMPORT_MAX_DAYS, IMPORT_MAX_EVENTS, type ImportEventInput } from '@facet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchEvents, runImport } from '../src/commands/import.js';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const SITE = '11111111-1111-4111-8111-111111111111';

function ev(timestamp: number): ImportEventInput {
	return { timestamp, visitor_id: 'v', hostname: 'h.example.com', path: '/' };
}

describe('batchEvents', () => {
	it('bounds a batch on event count', () => {
		const batches = batchEvents(
			Array.from({ length: IMPORT_MAX_EVENTS + 10 }, (_, i) => ev(T0 + i)),
		);
		expect(batches).toHaveLength(2);
		expect(batches[0]).toHaveLength(IMPORT_MAX_EVENTS);
		expect(batches[1]).toHaveLength(10);
	});

	// The count bound alone is not enough: 40 events one day apart is a small batch that the server
	// still refuses, because the post-import rollup/sessionization runs per distinct day.
	it('bounds a batch on distinct UTC days too', () => {
		const batches = batchEvents(
			Array.from({ length: IMPORT_MAX_DAYS + 5 }, (_, i) => ev(T0 + i * DAY_MS)),
		);
		expect(batches).toHaveLength(2);
		for (const batch of batches) {
			const days = new Set(
				batch.map((e) => new Date(e.timestamp).toISOString().slice(0, 10)),
			);
			expect(days.size).toBeLessThanOrEqual(IMPORT_MAX_DAYS);
		}
	});

	it('orders every batch ascending, whatever order the file was in', () => {
		const batches = batchEvents([ev(T0 + 3000), ev(T0), ev(T0 + 1000)]);
		expect(batches[0]?.map((e) => e.timestamp)).toEqual([T0, T0 + 1000, T0 + 3000]);
	});
});

describe('runImport', () => {
	let stdout: string;
	let stderr: string;
	let dir: string;

	beforeEach(() => {
		stdout = '';
		stderr = '';
		dir = mkdtempSync(join(tmpdir(), 'facet-import-'));
		vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
			stdout += String(c);
			return true;
		});
		vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
			stderr += String(c);
			return true;
		});
	});
	afterEach(() => vi.restoreAllMocks());

	const args = (file: string, extra: string[] = []) => [
		'--host',
		'https://facet.example.com',
		'--admin-token',
		't',
		'--site',
		SITE,
		'--file',
		file,
		...extra,
	];

	function write(name: string, body: string): string {
		const path = join(dir, name);
		writeFileSync(path, body);
		return path;
	}

	it('parses CSV, maps only known fields, and posts them', async () => {
		const file = write(
			'export.csv',
			'timestamp,visitor_id,hostname,path,name,country,utm_source,ip_address\n' +
				'2026-01-01T00:00:00Z,abc,h.example.com,/pricing,,us,hn,203.0.113.9\n' +
				'1767225600,def,h.example.com,"/a,b",signup,GB,,198.51.100.4\n',
		);
		let body: { events: ImportEventInput[] } | undefined;
		const code = await runImport(args(file), async (_url, init) => {
			body = JSON.parse(String(init?.body)) as { events: ImportEventInput[] };
			return { imported: 2, skipped: 0, days: ['2026-01-01'], note: 'n' } as never;
		});
		expect(code).toBe(0);
		expect(body?.events).toHaveLength(2);
		// A raw IP in the source export is dropped by the mapper, not forwarded and rejected server-side.
		expect(JSON.stringify(body)).not.toContain('203.0.113.9');
		expect(body?.events[0]).toMatchObject({
			timestamp: T0,
			visitor_id: 'abc',
			path: '/pricing',
			country: 'US',
			utm: { source: 'hn' },
		});
		// Epoch seconds are widened to ms, and a quoted comma survives the CSV split.
		expect(body?.events[1]).toMatchObject({ timestamp: 1767225600000, path: '/a,b' });
		expect(stdout).toContain('Imported');
	});

	it('reads NDJSON and forwards --dry-run', async () => {
		const file = write(
			'export.ndjson',
			`${JSON.stringify({ ...ev(T0), visitor_id: 'a' })}\n\n${JSON.stringify({ ...ev(T0 + 1), visitor_id: 'b' })}\n`,
		);
		let body: { dry_run?: boolean } | undefined;
		const code = await runImport(args(file, ['--dry-run']), async (_url, init) => {
			body = JSON.parse(String(init?.body)) as { dry_run?: boolean };
			return { imported: 0, skipped: 0, days: [], note: 'n', dry_run: true } as never;
		});
		expect(code).toBe(0);
		expect(body?.dry_run).toBe(true);
		expect(stdout).toContain('Dry run');
	});

	it('names the offending record when a required field is missing', async () => {
		const file = write(
			'export.csv',
			'timestamp,visitor_id,hostname\n1767225600000,a,h.example.com\n',
		);
		const code = await runImport(args(file), async () => ({}) as never);
		expect(code).toBe(1);
		expect(stderr).toContain('record 1');
		expect(stderr).toContain('path');
	});
});
