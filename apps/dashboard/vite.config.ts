// Vite config for the dashboard SPA. Builds to ./dist, which the Worker serves as static
// assets. React plugin enables the automatic JSX runtime; Tailwind plugin compiles the CSS.

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// Served from the domain root by the Worker (default). The static GitHub Pages demo is served from a
	// sub-path, so its build sets FACET_BASE=/facet/ to rewrite asset URLs accordingly.
	base: process.env.FACET_BASE || '/',
	build: {
		outDir: 'dist',
	},
});
