import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const dist = new URL('../apps/dashboard/dist/', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');
const entry = html.match(/<script[^>]+src="\/assets\/(index-[^"]+\.js)"/)?.[1];
if (!entry) throw new Error('Dashboard entry script was not found in dist/index.html; run the build first.');

const files = await readdir(new URL('assets/', dist));
const sizes = await Promise.all(
	files.map(async (name) => ({ name, bytes: (await stat(join(new URL('assets/', dist).pathname, name))).size })),
);
const totalJs = sizes.filter(({ name }) => name.endsWith('.js')).reduce((sum, file) => sum + file.bytes, 0);
const totalCss = sizes.filter(({ name }) => name.endsWith('.css')).reduce((sum, file) => sum + file.bytes, 0);
const entryBytes = sizes.find(({ name }) => name === entry)?.bytes ?? Number.POSITIVE_INFINITY;

const budgets = [
	['entry JavaScript', entryBytes, 300_000],
	['total JavaScript', totalJs, 1_000_000],
	['total CSS', totalCss, 100_000],
];
for (const [label, actual, maximum] of budgets) {
	if (actual > maximum) throw new Error(`${label} is ${actual} bytes; budget is ${maximum} bytes.`);
	console.log(`${label}: ${actual}/${maximum} bytes`);
}
