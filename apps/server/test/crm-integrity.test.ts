// Engine-level guarantees for the privacy-first CRM foundation. These tests use the real workerd
// D1 binding and generated CRM migration; only SQLite can prove the constraints actually hold.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { applyScoreDelta, listContactsPage } from '../src/db/crm.js';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

interface SeedContactOptions {
	score?: number;
	externalIdHash?: string;
	legalBasis?: string;
	consentCapturedAt?: number | null;
}

function seedHash(id: string): string {
	return Array.from(id)
		.map((character) => character.charCodeAt(0).toString(16).padStart(2, '0'))
		.join('')
		.padEnd(64, '0')
		.slice(0, 64);
}

async function insertContact(
	siteId: string,
	id: string,
	createdAt: number,
	opts: SeedContactOptions = {},
): Promise<void> {
	await env.CRM_DB.prepare(
		`INSERT INTO crm_contacts
		 (id, site_id, external_id_hash, alias, lifecycle_state, legal_basis, origin_source,
		  origin_occurred_at, consent_captured_at, score, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'lead', ?, 'api_test', ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			siteId,
			opts.externalIdHash ?? seedHash(id),
			`Visitor ${id}`,
			opts.legalBasis ?? 'contract',
			createdAt,
			opts.consentCapturedAt ?? null,
			opts.score ?? 0,
			createdAt,
			createdAt,
		)
		.run();
}

async function insertTag(siteId: string, id: string, normalizedName: string): Promise<void> {
	await env.CRM_DB.prepare(
		`INSERT INTO crm_tags
		 (id, site_id, normalized_name, display_name, color_token, created_at)
		 VALUES (?, ?, ?, ?, 'violet', ?)`,
	)
		.bind(id, siteId, normalizedName, normalizedName, Date.now())
		.run();
}

type CrmChildTable = 'crm_contact_events' | 'crm_contact_tags' | 'crm_score_ledger' | 'crm_tags';

async function tableCount(table: CrmChildTable): Promise<number | null> {
	return env.CRM_DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n');
}

describe('CRM structural integrity', () => {
	it('boots exactly the five isolated CRM tables from the generated migration', async () => {
		const { results } = await env.CRM_DB.prepare(
			`SELECT name FROM sqlite_schema
			 WHERE type = 'table' AND name LIKE 'crm_%'
			 ORDER BY name`,
		).all<{ name: string }>();

		expect(results.map((table) => table.name)).toEqual([
			'crm_contact_events',
			'crm_contact_tags',
			'crm_contacts',
			'crm_score_ledger',
			'crm_tags',
		]);
	});

	it('contains no legacy identity or raw contact PII columns', async () => {
		const { results } = await env.CRM_DB.prepare('PRAGMA table_info(crm_contacts)').all<{
			name: string;
			notnull: number;
		}>();
		const columns = results.map((column) => column.name);
		expect(columns).toContain('external_id_hash');
		expect(results.find((column) => column.name === 'external_id_hash')?.notnull).toBe(1);
		expect(columns).not.toEqual(
			expect.arrayContaining(['external_user_id', 'email', 'phone', 'name', 'notes']),
		);
	});

	it('requires a real legal basis and consent provenance when consent is the basis', async () => {
		await expect(
			insertContact(SITE_A, 'legacy-contact', 1, { legalBasis: 'legacy' }),
		).rejects.toThrow(/CHECK constraint failed/i);
		await expect(
			insertContact(SITE_A, 'consent-without-time', 1, { legalBasis: 'consent' }),
		).rejects.toThrow(/CHECK constraint failed/i);
		await expect(
			insertContact(SITE_A, 'consented-contact', 1, {
				legalBasis: 'consent',
				consentCapturedAt: 1,
			}),
		).resolves.toBeUndefined();
	});

	it('rejects a cross-tenant contact-tag association at the composite foreign key', async () => {
		await insertContact(SITE_A, 'contact-a', 1);
		await insertTag(SITE_B, 'tag-b', 'tenant-b');

		await expect(
			env.CRM_DB.prepare(
				`INSERT INTO crm_contact_tags (site_id, contact_id, tag_id, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
				.bind(SITE_B, 'contact-a', 'tag-b', 2)
				.run(),
		).rejects.toThrow(/FOREIGN KEY constraint failed/i);
		expect(await tableCount('crm_contact_tags')).toBe(0);
	});

	it('cascades contact-owned data while preserving shared tag definitions', async () => {
		await insertContact(SITE_A, 'contact-a', 1, { score: 10 });
		await insertTag(SITE_A, 'tag-a', 'high-value');
		await env.CRM_DB.batch([
			env.CRM_DB.prepare(
				`INSERT INTO crm_contact_tags (site_id, contact_id, tag_id, created_at)
				 VALUES (?, ?, ?, ?)`,
			).bind(SITE_A, 'contact-a', 'tag-a', 2),
			env.CRM_DB.prepare(
				`INSERT INTO crm_contact_events
				 (id, site_id, contact_id, event_type, payload, occurred_at)
				 VALUES (?, ?, ?, 'form.submitted', ?, ?)`,
			).bind('event-a', SITE_A, 'contact-a', JSON.stringify({ form: 'newsletter' }), 3),
		]);
		await applyScoreDelta(env.CRM_DB, SITE_A, 'contact-a', {
			delta: 5,
			reason: 'form_submitted',
			occurred_at: 4,
			ledger_id: 'ledger-a',
		});

		await env.CRM_DB.prepare('DELETE FROM crm_contacts WHERE site_id = ? AND id = ?')
			.bind(SITE_A, 'contact-a')
			.run();

		expect(await tableCount('crm_tags')).toBe(1);
		expect(await tableCount('crm_contact_tags')).toBe(0);
		expect(await tableCount('crm_contact_events')).toBe(0);
		expect(await tableCount('crm_score_ledger')).toBe(0);
	});

	it('enforces site-scoped digest uniqueness without returning the digest', async () => {
		const digest = 'a'.repeat(64);
		await insertContact(SITE_A, 'contact-a', 1, { externalIdHash: digest });
		await expect(
			insertContact(SITE_A, 'contact-b', 2, { externalIdHash: digest }),
		).rejects.toThrow(/UNIQUE constraint failed/i);
		await insertContact(SITE_B, 'contact-b', 2, { externalIdHash: digest });

		const page = await listContactsPage(env.CRM_DB, SITE_A, { limit: 10 });
		expect(page.contacts).toHaveLength(1);
		expect(page.contacts[0]).not.toHaveProperty('external_id_hash');
	});

	it('continues from an immutable cursor across intervening inserts and deletes', async () => {
		await Promise.all([
			insertContact(SITE_A, 'contact-d', 4_000),
			insertContact(SITE_A, 'contact-c', 3_000),
			insertContact(SITE_A, 'contact-b', 2_000),
			insertContact(SITE_A, 'contact-a', 1_000),
			insertContact(SITE_B, 'other-tenant', 9_000),
		]);

		const first = await listContactsPage(env.CRM_DB, SITE_A, { limit: 2 });
		expect(first.contacts.map((contact) => contact.id)).toEqual(['contact-d', 'contact-c']);
		expect(first.next_cursor).toEqual({ created_at: 3_000, id: 'contact-c' });

		await insertContact(SITE_A, 'contact-e', 5_000);
		await insertContact(SITE_A, 'contact-bb', 1_500);
		await env.CRM_DB.prepare('DELETE FROM crm_contacts WHERE site_id = ? AND id = ?')
			.bind(SITE_A, 'contact-b')
			.run();

		const second = await listContactsPage(env.CRM_DB, SITE_A, {
			limit: 2,
			cursor: first.next_cursor ?? undefined,
		});
		expect(second.contacts.map((contact) => contact.id)).toEqual(['contact-bb', 'contact-a']);
		expect(second.next_cursor).toBeNull();
	});

	it('uses id as a deterministic tie-breaker for same-millisecond contacts', async () => {
		await Promise.all([
			insertContact(SITE_A, 'contact-a', 1_000),
			insertContact(SITE_A, 'contact-c', 1_000),
			insertContact(SITE_A, 'contact-b', 1_000),
		]);

		const first = await listContactsPage(env.CRM_DB, SITE_A, { limit: 2 });
		expect(first.contacts.map((contact) => contact.id)).toEqual(['contact-c', 'contact-b']);
		const second = await listContactsPage(env.CRM_DB, SITE_A, {
			limit: 2,
			cursor: first.next_cursor ?? undefined,
		});
		expect(second.contacts.map((contact) => contact.id)).toEqual(['contact-a']);
	});

	it('uses the composite contact cursor index', async () => {
		const { results } = await env.CRM_DB.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT id FROM crm_contacts
			 WHERE site_id = ?
			   AND (created_at < ? OR (created_at = ? AND id < ?))
			 ORDER BY created_at DESC, id DESC
			 LIMIT ?`,
		)
			.bind(SITE_A, 10, 10, 'cursor-id', 25)
			.all<{ detail: string }>();
		const detail = results.map((row) => row.detail).join('\n');
		expect(detail).toContain('idx_crm_contacts_site_created_id');
		expect(detail).not.toMatch(/SCAN crm_contacts/i);
	});

	it('rolls back the score update when the ledger insert fails', async () => {
		await insertContact(SITE_A, 'contact-a', 1, { score: 10 });
		const applied = await applyScoreDelta(env.CRM_DB, SITE_A, 'contact-a', {
			delta: 5,
			reason: 'form_submitted',
			rule_id: 'rule.signup',
			occurred_at: 2,
			ledger_id: 'ledger-a',
		});
		expect(applied).toMatchObject({ previous_score: 10, delta: 5, next_score: 15 });

		await expect(
			applyScoreDelta(env.CRM_DB, SITE_A, 'contact-a', {
				delta: 7,
				reason: 'purchase_completed',
				occurred_at: 3,
				ledger_id: 'ledger-a',
			}),
		).rejects.toThrow(/UNIQUE constraint failed/i);

		expect(
			await env.CRM_DB.prepare('SELECT score FROM crm_contacts WHERE id = ?')
				.bind('contact-a')
				.first<number>('score'),
		).toBe(15);
		expect(await tableCount('crm_score_ledger')).toBe(1);
	});

	it('does not move the contact update timestamp backwards for backdated score events', async () => {
		await insertContact(SITE_A, 'contact-a', 10, { score: 10 });
		await applyScoreDelta(env.CRM_DB, SITE_A, 'contact-a', {
			delta: 5,
			reason: 'historical_import',
			occurred_at: 5,
			ledger_id: 'ledger-a',
		});

		expect(
			await env.CRM_DB.prepare('SELECT updated_at FROM crm_contacts WHERE id = ?')
				.bind('contact-a')
				.first<number>('updated_at'),
		).toBe(10);
	});

	it('rejects forged score arithmetic at the database boundary', async () => {
		await insertContact(SITE_A, 'contact-a', 1);
		await expect(
			env.CRM_DB.prepare(
				`INSERT INTO crm_score_ledger
				 (id, site_id, contact_id, previous_score, delta, next_score, reason, occurred_at)
				 VALUES ('forged', ?, 'contact-a', 0, 5, 99, 'manual_adjustment', 2)`,
			)
				.bind(SITE_A)
				.run(),
		).rejects.toThrow(/CHECK constraint failed/i);
	});
});
