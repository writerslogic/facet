// Vite config for the dashboard SPA. Builds to ./dist, which the Worker serves as static
// assets. React plugin enables the automatic JSX runtime; Tailwind plugin compiles the CSS.

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		outDir: 'dist',
	},
});
