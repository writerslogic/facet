// CSV serialization with correct escaping and spreadsheet formula-injection protection. String
// cells that a spreadsheet would evaluate (leading =, +, -, @, tab, or CR) are neutralized with a
// leading apostrophe; numeric cells are never formula-guarded. Rows are CRLF-terminated per RFC 4180.

type Cell = string | number;

function csvCell(value: Cell): string {
	if (typeof value === 'number') {
		const n = String(value);
		return /[",\n\r]/.test(n) ? `"${n}"` : n;
	}
	let s = value;
	// Formula-injection guard: a cell beginning with one of these is treated as a formula by Excel/
	// Sheets. Prefix with a single quote so it is rendered as literal text.
	if (/^[=+\-@\t\r]/.test(s)) {
		s = `'${s}`;
	}
	// Standard quoting: wrap in quotes and double any embedded quotes when the cell contains a comma,
	// quote, or newline.
	if (/[",\n\r]/.test(s)) {
		s = `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

/** Serialize `rows` under `headers` to an RFC-4180 CSV string (CRLF line endings, trailing newline). */
export function toCsv(headers: string[], rows: Cell[][]): string {
	const lines = [headers.map(csvCell).join(',')];
	for (const row of rows) {
		lines.push(row.map(csvCell).join(','));
	}
	return `${lines.join('\r\n')}\r\n`;
}
