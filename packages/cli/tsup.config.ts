import { defineConfig } from 'tsup';

// The published `facet` bin must start with a shebang so it is directly executable (publint
// bin-non-executable). tsup injects it as a banner on the ESM output.
export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	dts: true,
	banner: { js: '#!/usr/bin/env node' },
});
