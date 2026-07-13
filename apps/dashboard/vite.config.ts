// Vite config for the dashboard SPA. Builds to ./dist, which the Worker serves as static
// assets. React plugin enables the automatic JSX runtime.

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: 'dist',
	},
});
