// F.21: CSV serialization escapes quotes/commas/newlines and neutralizes spreadsheet formula
// injection on string cells; numeric cells are never formula-guarded.

import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/csv.js';

describe('toCsv', () => {
	it('emits a header row and CRLF-terminated data rows', () => {
		const csv = toCsv(['key', 'count'], [['/', 3]]);
		expect(csv).toBe('key,count\r\n/,3\r\n');
	});

	it('quotes cells containing commas, quotes, or newlines', () => {
		expect(toCsv(['a'], [['x,y']])).toBe('a\r\n"x,y"\r\n');
		expect(toCsv(['a'], [['he said "hi"']])).toBe('a\r\n"he said ""hi"""\r\n');
		expect(toCsv(['a'], [['line1\nline2']])).toBe('a\r\n"line1\nline2"\r\n');
	});

	it('neutralizes formula-injection cells with a leading apostrophe', () => {
		for (const dangerous of ['=SUM(A1)', '+1', '-1+1', '@cmd', '\ttab']) {
			const csv = toCsv(['a'], [[dangerous]]);
			expect(csv.startsWith("a\r\n'")).toBe(true);
		}
	});

	it('does not formula-guard numeric cells', () => {
		expect(toCsv(['n'], [[-5]])).toBe('n\r\n-5\r\n');
		expect(toCsv(['n'], [[0]])).toBe('n\r\n0\r\n');
	});
});
