// P3.6/P3.7: credential-issuing endpoints. /api/attestation/privacy issues a signed
// PrivacyAttestationCredential (deployment properties + DPV claims); /api/stats/report issues a signed
// AnalyticsReportCredential over an aggregate snapshot. Both verify against the deployment key and
// 501 when signing is unconfigured. The report subject is the dataset, never a person.

import { env } from 'cloudflare:test';
import { type VerifiableCredential, generateSigningJwk, verifyCredential } from '@facet/trust';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type NewEvent, insertEvent } from '../src/db/queries.js';
import { issueKey } from '../src/lib/apikeys.js';

const SITE = '77777777-7777-4777-8777-777777777777';
const T0 = Date.UTC(2026, 3, 1, 0, 0, 0, 0);
const END = T0 + 3 * 3_600_000;

let apiKey: string;
let privateJwk: string;
let publicJwk: Awaited<ReturnType<typeof generateSigningJwk>>['publicJwk'];

function mk(i: number): NewEvent {
	return {
		siteId: SITE,
		hostname: 'x.example.com',
		path: '/',
		referrer: '',
		name: null,
		props: null,
		visitorHash: `v${i}`,
		country: 'US',
		device: 'desktop',
		createdAt: T0 + i * 1000,
	};
}

beforeEach(async () => {
	apiKey = (await issueKey(env, SITE, null, Date.now())).key;
	const gen = await generateSigningJwk('EdDSA');
	privateJwk = JSON.stringify(gen.privateJwk);
	publicJwk = gen.publicJwk;
});

function withKey() {
	return {
		...env,
		FACET_SIGNING_JWK: privateJwk,
		FACET_BUILD_ID: 'ci-99',
		FACET_GIT_COMMIT: 'abc123',
	};
}

describe('GET /api/attestation/privacy', () => {
	it('issues a verifiable PrivacyAttestationCredential with deployment + DPV claims', async () => {
		const res = await createApp().request(
			'https://facet.example/api/attestation/privacy',
			{},
			withKey(),
		);
		expect(res.status).toBe(200);
		const vc = (await res.json()) as VerifiableCredential;
		expect(vc.type).toContain('PrivacyAttestationCredential');
		expect(vc.issuer).toBe('did:web:facet.example');

		const subject = vc.credentialSubject as {
			deployment: {
				schemaHash: string;
				buildId: string;
				privacy: { storesRawIp: boolean };
			};
			dpv: Record<string, unknown>;
		};
		expect(subject.deployment.buildId).toBe('ci-99');
		expect(subject.deployment.schemaHash).toMatch(/^[0-9a-f]{64}$/);
		expect(subject.deployment.privacy.storesRawIp).toBe(false);
		expect(subject.dpv['dpv:hasPurpose']).toBe('dpv:ServiceOptimisation');

		expect((await verifyCredential(vc, { publicJwk })).valid).toBe(true);
	});

	it('501s when signing is unconfigured', async () => {
		const res = await createApp().request(
			'https://facet.example/api/attestation/privacy',
			{},
			env,
		);
		expect(res.status).toBe(501);
	});
});

describe('GET /api/stats/report', () => {
	it('issues a verifiable AnalyticsReportCredential over the aggregate snapshot', async () => {
		await insertEvent(env, mk(0));
		await insertEvent(env, mk(1));
		const res = await createApp().request(
			`https://facet.example/api/stats/report?site_id=${SITE}&start=${T0}&end=${END}`,
			{ headers: { Authorization: `Bearer ${apiKey}` } },
			withKey(),
		);
		expect(res.status).toBe(200);
		const vc = (await res.json()) as VerifiableCredential;
		expect(vc.type).toContain('AnalyticsReportCredential');
		const subject = vc.credentialSubject as {
			id: string;
			site: string;
			report: { pageviews: number; visitors: number };
		};
		expect(subject.id).toBe(`https://facet.example/sites/${SITE}`);
		expect(subject.site).toBe(SITE);
		expect(subject.report.pageviews).toBe(2);
		expect((await verifyCredential(vc, { publicJwk })).valid).toBe(true);
	});

	it('501s when signing is unconfigured', async () => {
		const res = await createApp().request(
			`https://facet.example/api/stats/report?site_id=${SITE}&start=${T0}&end=${END}`,
			{ headers: { Authorization: `Bearer ${apiKey}` } },
			env,
		);
		expect(res.status).toBe(501);
	});

	it('rejects a cross-site key with 403', async () => {
		const res = await createApp().request(
			`https://facet.example/api/stats/report?site_id=11111111-1111-4111-8111-111111111111&start=${T0}&end=${END}`,
			{ headers: { Authorization: `Bearer ${apiKey}` } },
			withKey(),
		);
		expect(res.status).toBe(403);
	});
});
