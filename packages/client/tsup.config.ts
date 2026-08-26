// Two build outputs: (1) the ESM library (index + auto, with .d.ts) for npm consumers, and
// (2) a standalone minified IIFE `script.js` for the drop-in <script src=".../script.js"> tag.
//
// IMPORTANT: neither entry may set `clean`. tsup runs the two configs concurrently, so a `clean` on
// one races the other's write — when the clean lands second it deletes `dist/script.js`, and
// test/size.test.ts then `describe.skipIf`s itself, dropping the gzip budget guard with no failure.
// The build script clears dist once, up front, instead.

import { defineConfig } from 'tsup';

export default defineConfig([
	{
		entry: ['src/index.ts', 'src/auto.ts'],
		format: ['esm'],
		dts: true,
	},
	{
		entry: { script: 'src/auto.ts' },
		format: ['iife'],
		minify: true,
		dts: false,
		outExtension: () => ({ js: '.js' }),
	},
]);
