// Vite config for the dashboard SPA. Builds to ./dist, which the Worker serves as static
// assets. React plugin enables the automatic JSX runtime; Tailwind plugin compiles the CSS.

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Long-lived third-party code, split out of the app chunk so a dashboard redeploy does not invalidate
// it in users' caches. Only dependencies that are genuinely needed on first paint belong here — the
// on-demand ones (uplot, the world geometry) must stay in their own lazily-fetched chunks.
const VENDOR_CHUNKS: Record<string, readonly string[]> = {
	'vendor-react': ['react-dom', 'react', 'scheduler'],
	'vendor-query': ['@tanstack/query-core', '@tanstack/react-query'],
	'vendor-style': ['tailwind-merge', 'clsx', 'class-variance-authority'],
};

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// Served from the domain root by the Worker (default). The static GitHub Pages demo is served from a
	// sub-path, so its build sets FACET_BASE=/facet/ to rewrite asset URLs accordingly.
	base: process.env.FACET_BASE || '/',
	build: {
		outDir: 'dist',
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (!id.includes('node_modules')) return undefined;
					// pnpm nests real packages under node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/…,
					// so match on the last segment to get the importable package name.
					const pkg = id.split('node_modules/').pop()?.split('/') ?? [];
					const name = pkg[0]?.startsWith('@') ? `${pkg[0]}/${pkg[1]}` : pkg[0];
					if (!name) return undefined;
					for (const [chunk, members] of Object.entries(VENDOR_CHUNKS)) {
						if (members.includes(name)) return chunk;
					}
					return undefined;
				},
			},
		},
	},
});
