// drizzle-kit config for the OPTIONAL CRM database. Separate from drizzle.config.ts because the CRM
// lives in its own D1 database (`CRM_DB`), not in a table set inside the analytics one — so it needs
// its own schema file, its own migration directory, and its own `wrangler d1 migrations apply`
// target. A deployment that never binds CRM_DB never runs these, and the tables do not exist.
// Run with `pnpm --filter @facet/server db:generate:crm`.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	schema: './src/db/crm-schema.ts',
	out: './migrations-crm',
});
