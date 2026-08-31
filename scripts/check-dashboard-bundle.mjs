import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

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
	files.map(async (name) => ({ name, bytes: (await stat(join(new URL('assets/', dist).pathname, name))).size })),
);
const totalJs = sizes.filter(({ name }) => name.endsWith('.js')).reduce((sum, file) => sum + file.bytes, 0);
const totalCss = sizes.filter(({ name }) => name.endsWith('.css')).reduce((sum, file) => sum + file.bytes, 0);
const entryBytes = sizes.find(({ name }) => name === entry)?.bytes ?? Number.POSITIVE_INFINITY;

// `entry JavaScript` is the budget that protects users: it is what every visitor downloads before
// the dashboard is interactive, and it does NOT move. `total JavaScript` covers the code-split tab
// chunks too — no session ever fetches all of them — so it guards unbounded growth rather than first
// paint. Raised from 1,000,000 once, for the Explore tab: the app had 3.3 KB of headroom left, which
// is less than any real tab costs. Trim before raising it again.
const budgets = [
	['entry JavaScript', entryBytes, 300_000],
	['total JavaScript', totalJs, 1_050_000],
	['total CSS', totalCss, 100_000],
];
for (const [label, actual, maximum] of budgets) {
	if (actual > maximum) throw new Error(`${label} is ${actual} bytes; budget is ${maximum} bytes.`);
	console.log(`${label}: ${actual}/${maximum} bytes`);
}
