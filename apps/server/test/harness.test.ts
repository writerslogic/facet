import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** Every application table the migrations are expected to create, sorted.
 *
 * Asserted by NAME rather than by count on purpose: a bare number tells you only that "something
 * changed", so a renamed or missing table looked identical to a legitimately added one. A set
 * comparison names exactly what appeared or disappeared, and adding a table here is a deliberate
 * one-line acknowledgement that the schema grew. */
const EXPECTED_TABLES = [
	'alert_deliveries',
	'alert_destinations',
	'api_keys',
	'auth_tokens',
	'consent_records',
	'event_rollups',
	'event_sessions',
	'events',
	'experiments',
	'flags',
	'funnels',
	'goals',
	'identity_salts',
	'memberships',
	'mmr_checkpoints',
	'mmr_leaves',
	'mmr_nodes',
	'salts',
	'scheduled_job_runs',
	'scitt_log',
	'sessions',
	'site_config',
	'sites',
	'teams',
	'users',
];

describe('test harness', () => {
	it('has a D1 binding', () => {
		expect(env.DB).toBeDefined();
	});

	it('creates exactly the expected tables after migrations', async () => {
		const result = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
		).all<{ name: string }>();
		const actual = result.results.map((r) => r.name);
		const missing = EXPECTED_TABLES.filter((t) => !actual.includes(t));
		const unexpected = actual.filter((t) => !EXPECTED_TABLES.includes(t));
		expect({ missing, unexpected }).toEqual({ missing: [], unexpected: [] });
		expect(actual).toEqual(EXPECTED_TABLES);
	});

	it('events table has 29 columns', async () => {
		const result = await env.DB.prepare('PRAGMA table_info(events)').all<{
			name: string;
		}>();
		expect(result.results.length).toBe(29);
	});
});
