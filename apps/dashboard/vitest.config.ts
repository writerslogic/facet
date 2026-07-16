// Vitest config for the dashboard: jsdom environment for React component tests, with the
// jest-dom matchers registered via the setup file.

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [react()],
	test: {
		environment: 'jsdom',
		environmentOptions: { jsdom: { url: 'http://localhost/' } },
		setupFiles: ['./src/test/setup.ts'],
	},
});
