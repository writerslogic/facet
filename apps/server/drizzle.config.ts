// drizzle-kit config: generates D1 SQL migrations into ./migrations from src/db/schema.ts.
// Run with `pnpm --filter @countless/server db:generate`.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	schema: './src/db/schema.ts',
	out: './migrations',
});
