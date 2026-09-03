import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

const dist = new URL('../apps/dashboard/dist/', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');
const entry = html.match(/<script[^>]+src="\/assets\/(index-[^"]+\.js)"/)?.[1];
if (!entry) throw new Error('Dashboard entry script was not found in dist/index.html; run the build first.');

// The drop-in tracker is copied in by the dashboard build (see vite.config.ts `tracker()`), because
// the Worker serves it from this directory and the documented <script src=".../script.js"> tag 404s
// without it. Asserted here so the copy cannot regress silently the way its absence originally did.
const tracker = await stat(new URL('script.js', dist)).catch(() => null);
if (!tracker) {
	throw new Error('dist/script.js is missing; the drop-in tracker tag would 404. See apps/dashboard/vite.config.ts.');
}
console.log(`tracker script.js: ${tracker.size} bytes`);

const files = await readdir(new URL('assets/', dist));
const sizes = await Promise.all(
	files.map(async (name) => {
		const path = join(new URL('assets/', dist).pathname, name);
		const content = await readFile(path);
		const [gzipped, brotli] = await Promise.all([
			gzipAsync(content, { level: 9 }),
			brotliAsync(content, {
				params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
			}),
		]);
		return {
			name,
			bytes: content.byteLength,
			gzipBytes: gzipped.byteLength,
			brotliBytes: brotli.byteLength,
			imports: [
				...content
					.toString('utf8')
					.matchAll(/\b(?:import|export)[^"'()]*?from["']\.\/([^"']+\.js)["']/g),
			].map((match) => match[1]),
		};
	}),
);
const totalJs = sizes.filter(({ name }) => name.endsWith('.js')).reduce((sum, file) => sum + file.bytes, 0);
const totalCss = sizes.filter(({ name }) => name.endsWith('.css')).reduce((sum, file) => sum + file.bytes, 0);
const entryBytes = sizes.find(({ name }) => name === entry)?.bytes ?? Number.POSITIVE_INFINITY;
const entryGzipBytes =
	sizes.find(({ name }) => name === entry)?.gzipBytes ?? Number.POSITIVE_INFINITY;
const entryBrotliBytes =
	sizes.find(({ name }) => name === entry)?.brotliBytes ?? Number.POSITIVE_INFINITY;
const byName = new Map(sizes.map((file) => [file.name, file]));
const initialNames = new Set([entry]);
const pending = [entry];
while (pending.length > 0) {
	const current = pending.pop();
	if (!current) continue;
	for (const imported of byName.get(current)?.imports ?? []) {
		if (initialNames.has(imported)) continue;
		initialNames.add(imported);
		pending.push(imported);
	}
}
const initial = [...initialNames].map((name) => byName.get(name)).filter(Boolean);
const initialBytes = initial.reduce((sum, file) => sum + file.bytes, 0);
const initialGzipBytes = initial.reduce((sum, file) => sum + file.gzipBytes, 0);
const initialBrotliBytes = initial.reduce((sum, file) => sum + file.brotliBytes, 0);

// `initial JavaScript` traverses static ESM imports from the HTML entry and is therefore the real
// cold-boot graph. `total JavaScript` covers code-split tab chunks too — no session fetches all of
// them — so it only guards unbounded repository growth. These ceilings leave modest headroom; trim
// before raising them.
const budgets = [
	['application entry JavaScript', entryBytes, 325_000],
	['application entry JavaScript (gzip)', entryGzipBytes, 75_000],
	['initial JavaScript graph', initialBytes, 500_000],
	['initial JavaScript graph (gzip)', initialGzipBytes, 150_000],
	['total JavaScript', totalJs, 1_100_000],
	['total CSS', totalCss, 100_000],
];
for (const [label, actual, maximum] of budgets) {
	if (actual > maximum) throw new Error(`${label} is ${actual} bytes; budget is ${maximum} bytes.`);
	console.log(`${label}: ${actual}/${maximum} bytes`);
}
console.log(`application entry JavaScript (Brotli): ${entryBrotliBytes} bytes`);
console.log(`initial JavaScript graph (Brotli): ${initialBrotliBytes} bytes`);
console.log(`initial graph chunks: ${initialNames.size}`);

const largest = sizes
	.filter(({ name }) => name.endsWith('.js'))
	.sort((a, b) => b.gzipBytes - a.gzipBytes)
	.slice(0, 5);
console.log('largest JavaScript chunks by gzip:');
for (const file of largest) {
	console.log(
		`  ${file.name}: ${file.bytes} raw / ${file.gzipBytes} gzip / ${file.brotliBytes} Brotli`,
	);
}
