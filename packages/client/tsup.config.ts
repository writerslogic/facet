// Two build outputs: (1) the ESM library (index + auto, with .d.ts) for npm consumers, and
// (2) a standalone minified IIFE `script.js` for the drop-in <script src=".../script.js"> tag.

import { defineConfig } from 'tsup';

export default defineConfig([
	{
		entry: ['src/index.ts', 'src/auto.ts'],
		format: ['esm'],
		dts: true,
		clean: true,
	},
	{
		entry: { script: 'src/auto.ts' },
		format: ['iife'],
		minify: true,
		dts: false,
		outExtension: () => ({ js: '.js' }),
	},
]);
