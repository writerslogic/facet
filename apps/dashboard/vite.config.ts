// Vite config for the dashboard SPA. Builds to ./dist, which the Worker serves as static
// assets. React plugin enables the automatic JSX runtime; Tailwind plugin compiles the CSS.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

/** The built drop-in tracker, resolved through the workspace link rather than a relative path so it
 * cannot drift if either package moves. */
function trackerPath(): string {
	const require = createRequire(import.meta.url);
	return join(dirname(require.resolve('@writerslogic/facet/package.json')), 'dist', 'script.js');
}

/**
 * Serve and ship the drop-in tracker at `/script.js`.
 *
 * IMPORTANT: without this the documented `<script src=".../script.js">` tag 404s. The Worker serves
 * every non-`/api/` path from this dist directory (wrangler.jsonc `assets.directory`), and a
 * `<script src>` request sends a wildcard Accept header, so it misses the SPA's text/html fallback
 * and gets a bare 404 rather than the app shell. The tracker is built by a different package, so nothing put it
 * here until now. The build FAILS LOUDLY if the artifact is missing, because a silent miss is exactly
 * how this shipped broken.
 */
function tracker(): Plugin {
	return {
		name: 'facet-tracker-asset',
		configureServer(server) {
			server.middlewares.use('/script.js', (_req, res, next) => {
				const src = trackerPath();
				if (!existsSync(src)) return next();
				res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
				res.end(readFileSync(src));
			});
		},
		closeBundle() {
			const src = trackerPath();
			if (!existsSync(src)) {
				throw new Error(
					`Tracker not built: ${src} is missing. Build @writerslogic/facet before the dashboard (the root \`build\` script does).`,
				);
			}
			copyFileSync(src, join(dirname(fileURLToPath(import.meta.url)), 'dist', 'script.js'));
		},
	};
}

// Long-lived third-party code, split out of the app chunk so a dashboard redeploy does not invalidate
// it in users' caches. Only dependencies that are genuinely needed on first paint belong here — the
// on-demand ones (uplot, the world geometry) must stay in their own lazily-fetched chunks.
const VENDOR_CHUNKS: Record<string, readonly string[]> = {
	'vendor-react': ['react-dom', 'react', 'scheduler'],
	'vendor-query': ['@tanstack/query-core', '@tanstack/react-query'],
	'vendor-style': ['tailwind-merge', 'clsx', 'class-variance-authority'],
};

export default defineConfig({
	plugins: [react(), tailwindcss(), tracker()],
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
