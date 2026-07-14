// T018: API key issuance/hashing/listing/revocation — hashes only, plaintext shown once.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hashKey, issueKey, listKeys, revokeKey } from '../src/lib/apikeys.js';

const SITE = '11111111-1111-4111-8111-111111111111';

describe('apikeys', () => {
	it('issues a clk_-prefixed 68-char key', async () => {
		const { key } = await issueKey(env, SITE, 'ci', Date.now());
		expect(key.startsWith('clk_')).toBe(true);
		expect(key).toHaveLength(68);
	});

	it('stores a 64-hex hash of the key, never the plaintext', async () => {
		const { id, key } = await issueKey(env, SITE, null, Date.now());
		const row = await env.DB.prepare('SELECT key_hash FROM api_keys WHERE id = ?')
			.bind(id)
			.first<{ key_hash: string }>();
		expect(row?.key_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.key_hash).not.toBe(key);
		expect(row?.key_hash).toBe(await hashKey(key));
	});

	it('listKeys returns records without any hash or plaintext field', async () => {
		await issueKey(env, SITE, 'a', Date.now());
		const keys = await listKeys(env, SITE);
		expect(keys.length).toBeGreaterThan(0);
		for (const k of keys) {
			expect(k).not.toHaveProperty('key_hash');
			expect(k).not.toHaveProperty('key');
			expect(k.site_id).toBe(SITE);
		}
	});

	it('revokeKey deletes once, then returns false', async () => {
		const { id } = await issueKey(env, SITE, null, Date.now());
		expect(await revokeKey(env, id, SITE)).toBe(true);
		expect(await revokeKey(env, id, SITE)).toBe(false);
	});

	it('distinct issuances yield distinct keys and hashes', async () => {
		const a = await issueKey(env, SITE, null, Date.now());
		const b = await issueKey(env, SITE, null, Date.now());
		expect(a.key).not.toBe(b.key);
		expect(await hashKey(a.key)).not.toBe(await hashKey(b.key));
	});
});
