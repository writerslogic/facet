// P4.8: MMR transparency log over finalized event_rollups. The cron appends leaves + emits a signed
// checkpoint; the endpoints serve the checkpoint, an inclusion receipt for a site's rollup, and a
// consistency proof between two tree states. Verified end-to-end with @facet/trust. No-op without a
// signing key. Leaves commit aggregate rollups, never raw events.

import { env } from 'cloudflare:test';
import {
	generateSigningJwk,
	verifyCheckpoint,
	verifyConsistencyReceipt,
	verifyInclusionReceipt,
} from '@facet/trust';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { issueKey } from '../src/lib/apikeys.js';
import { runTransparency } from '../src/lib/transparency.js';

const SITE = '66666666-6666-4666-8666-666666666666';
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const H = 3_600_000;

let apiKey: string;
let signingEnv: typeof env & { FACET_SIGNING_JWK: string };

/** Insert a finalized hourly rollup directly (bucket well in the past). */
async function seedRollup(bucketStart: number, pageviews: number): Promise<void> {
	await env.DB.prepare(
		'INSERT INTO event_rollups (site_id, hostname, bucket_start, interval, pageviews, events, visitors) VALUES (?,?,?,?,?,?,?)',
	)
		.bind(SITE, 'x.example.com', bucketStart, 'hour', pageviews, 0, pageviews)
		.run();
}

beforeEach(async () => {
	apiKey = (await issueKey(env, SITE, null, Date.now())).key;
	const gen = await generateSigningJwk('EdDSA');
	signingEnv = { ...env, FACET_SIGNING_JWK: JSON.stringify(gen.privateJwk) };
});

describe('transparency log', () => {
	it('appends finalized rollups, emits a verifiable checkpoint, and proves inclusion', async () => {
		await seedRollup(NOW - 4 * H, 10);
		await seedRollup(NOW - 3 * H, 20);
		await seedRollup(NOW - 2 * H, 30);
		await runTransparency(signingEnv, NOW);

		// Checkpoint verifies and commits a non-empty tree.
		const cpRes = await createApp().request(
			'https://facet.example/api/transparency/checkpoint',
			{},
			signingEnv,
		);
		expect(cpRes.status).toBe(200);
		const checkpoint = await cpRes.json();
		const v = await verifyCheckpoint(checkpoint as never);
		expect(v.valid).toBe(true);
		expect((checkpoint as { payload: { size: number } }).payload.size).toBeGreaterThan(0);

		// Inclusion receipt for one of the site's rollups verifies against the checkpoint root.
		const incRes = await createApp().request(
			`https://facet.example/api/transparency/inclusion?site_id=${SITE}&hostname=x.example.com&bucket_start=${NOW - 3 * H}&interval=hour`,
			{ headers: { Authorization: `Bearer ${apiKey}` } },
			signingEnv,
		);
		expect(incRes.status).toBe(200);
		const inc = (await incRes.json()) as {
			root: string;
			receipt: Parameters<typeof verifyInclusionReceipt>[0];
		};
		expect(await verifyInclusionReceipt(inc.receipt, inc.root)).toBe(true);
	});

	it('404s inclusion for a rollup that was never logged', async () => {
		await seedRollup(NOW - 3 * H, 20);
		await runTransparency(signingEnv, NOW);
		const res = await createApp().request(
			`https://facet.example/api/transparency/inclusion?site_id=${SITE}&hostname=x.example.com&bucket_start=${NOW - 99 * H}&interval=hour`,
			{ headers: { Authorization: `Bearer ${apiKey}` } },
			signingEnv,
		);
		expect(res.status).toBe(404);
	});

	it('proves consistency between an earlier and a later checkpoint', async () => {
		await seedRollup(NOW - 5 * H, 5);
		await seedRollup(NOW - 4 * H, 5);
		await runTransparency(signingEnv, NOW);
		const cpA = (await (
			await createApp().request(
				'https://facet.example/api/transparency/checkpoint',
				{},
				signingEnv,
			)
		).json()) as { payload: { size: number; root: string } };

		await seedRollup(NOW - 3 * H, 5);
		await seedRollup(NOW - 2 * H, 5);
		await runTransparency(signingEnv, NOW);
		const cpB = (await (
			await createApp().request(
				'https://facet.example/api/transparency/checkpoint',
				{},
				signingEnv,
			)
		).json()) as { payload: { size: number; root: string } };
		expect(cpB.payload.size).toBeGreaterThan(cpA.payload.size);

		const conRes = await createApp().request(
			`https://facet.example/api/transparency/consistency?from=${cpA.payload.size}&to=${cpB.payload.size}`,
			{},
			signingEnv,
		);
		expect(conRes.status).toBe(200);
		const con = (await conRes.json()) as {
			receipt: Parameters<typeof verifyConsistencyReceipt>[0];
		};
		expect(
			await verifyConsistencyReceipt(con.receipt, cpA.payload.root, cpB.payload.root),
		).toBe(true);
	});

	it('is a no-op without a signing key (checkpoint 404)', async () => {
		await seedRollup(NOW - 3 * H, 20);
		await runTransparency(env, NOW);
		const res = await createApp().request(
			'https://facet.example/api/transparency/checkpoint',
			{},
			env,
		);
		expect(res.status).toBe(404);
	});
});
