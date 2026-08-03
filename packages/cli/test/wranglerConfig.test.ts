// The comment-preserving wrangler.jsonc transforms, exercised against the real shipped config so a
// change to its shape breaks here rather than during someone's install.

import { describe, expect, it } from 'vitest';
import {
	commentOutQueues,
	getDatabaseId,
	getQueueName,
	getRoutePattern,
	getWorkerName,
	hasQueues,
	setDatabaseId,
	setRoutePattern,
} from '../src/lib/wranglerConfig.js';
import { freshConfig } from './support.js';

const ID = '11111111-2222-4333-8444-555555555555';

describe('wranglerConfig', () => {
	it('reads the shipped config', () => {
		const source = freshConfig();
		expect(getWorkerName(source)).toBe('facet');
		expect(getDatabaseId(source)).toBeNull(); // placeholder counts as unset
		expect(getQueueName(source)).toBe('facet-ingest');
		expect(getRoutePattern(source)).toBe('facet.writerslogic.com');
		expect(hasQueues(source)).toBe(true);
	});

	it('sets the database id while preserving every comment', () => {
		const source = freshConfig();
		const edit = setDatabaseId(source, ID);
		expect(edit.ok).toBe(true);
		if (!edit.ok) return;
		expect(edit.source).toContain(`"database_id": "${ID}"`);
		expect(edit.source).toContain('// Facet Worker config');
		expect(edit.source).toContain('// POST-v1 SCALE PATH');
		// Byte-identical apart from the id itself.
		expect(edit.source.replace(ID, 'PLACEHOLDER_D1_DATABASE_ID')).toBe(source);
	});

	it('refuses to clobber a real database id unless forced', () => {
		const source = setDatabaseId(freshConfig(), ID) as { ok: true; source: string };
		const blocked = setDatabaseId(source.source, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
		expect(blocked.ok).toBe(false);
		if (blocked.ok) return;
		expect(blocked.reason).toContain('Refusing to overwrite');
		const forced = setDatabaseId(source.source, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', true);
		expect(forced.ok).toBe(true);
	});

	it('replaces the route pattern in place', () => {
		const edit = setRoutePattern(freshConfig(), 'stats.example.com');
		expect(edit.ok).toBe(true);
		if (!edit.ok) return;
		expect(getRoutePattern(edit.source)).toBe('stats.example.com');
		expect(edit.source).not.toContain('facet.writerslogic.com');
	});

	it('comments the route out for a workers.dev deploy, and can add one back', () => {
		const off = setRoutePattern(freshConfig(), null) as { ok: true; source: string };
		expect(getRoutePattern(off.source)).toBeNull();
		expect(off.source).toContain('// "routes": [{ "pattern": "facet.writerslogic.com"');

		const on = setRoutePattern(off.source, 'stats.example.com') as { ok: true; source: string };
		expect(getRoutePattern(on.source)).toBe('stats.example.com');
		// The old, commented-out line is left as the record of what was there before.
		expect(on.source).toContain('// "routes"');
	});

	it('refuses to guess at a multi-line routes entry', () => {
		const source = freshConfig().replace(
			/"routes".*$/m,
			'"routes": [\n    { "pattern": "x" }\n  ],',
		);
		const edit = setRoutePattern(source, 'stats.example.com');
		expect(edit.ok).toBe(false);
		if (edit.ok) return;
		expect(edit.reason).toContain('spans several lines');
	});

	it('comments out the whole queues block and leaves the rest intact', () => {
		const source = freshConfig();
		const edit = commentOutQueues(source);
		expect(edit.ok).toBe(true);
		if (!edit.ok) return;
		expect(hasQueues(edit.source)).toBe(false);
		expect(edit.source).toContain('// "queues": {');
		expect(edit.source).toContain('// "producers": [{ "binding": "INGEST_QUEUE"');
		// Untouched neighbours.
		expect(edit.source).toContain('"binding": "DB"');
		expect(edit.source).toContain('"RAW_RETENTION_DAYS": "90"');
		// Still parseable once comments and trailing commas are stripped, which is how the Worker's
		// test-config generator reads it.
		const stripped = edit.source
			.replace(/(^|[^:])\/\/.*$/gm, '$1')
			.replace(/,(\s*[}\]])/g, '$1');
		expect(() => JSON.parse(stripped)).not.toThrow();
		expect(JSON.parse(stripped).queues).toBeUndefined();
		expect(JSON.parse(stripped).d1_databases).toHaveLength(1);
	});

	it('commenting out queues twice is a no-op', () => {
		const once = commentOutQueues(freshConfig()) as { ok: true; source: string };
		const twice = commentOutQueues(once.source) as { ok: true; source: string };
		expect(twice.source).toBe(once.source);
	});
});
