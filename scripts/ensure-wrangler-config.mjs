// Materialize the machine-local Wrangler config from the tracked template. It is intentionally
// create-only: installs and dependency refreshes must never overwrite a deployment's D1 ids, routes,
// or optional bindings.

import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';

const template = new URL('../apps/server/wrangler.example.jsonc', import.meta.url);
const local = new URL('../apps/server/wrangler.jsonc', import.meta.url);

try {
	await copyFile(template, local, constants.COPYFILE_EXCL);
	console.log('Created apps/server/wrangler.jsonc from wrangler.example.jsonc.');
} catch (error) {
	if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
}
