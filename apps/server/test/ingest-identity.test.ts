// Ingest under the identity spectrum (U2 wiring). Proves: a zero-config site is the legacy Tier-0
// hash (no-op); GPC is enforced INSIDE ingestEvent (structural backstop, not just at the route); an
// elevated site with a valid consent record writes the windowed hash; and an elevated site WITHOUT
// consent silently downgrades to the Tier-0 day hash (never dropped).

import { env } from "cloudflare:test";
import { generateSigningJwk, loadSigningKey } from "@facet/trust";
import { beforeEach, describe, expect, it } from "vitest";
import { signConsent, storeConsentRecord } from "../src/lib/consent.js";
import { visitorHash } from "../src/lib/hash.js";
import {
	deriveVisitorHash,
	getScopedSalt,
	windowEndMs,
	windowKey,
} from "../src/lib/identity.js";
import { ingestEvent } from "../src/lib/ingest.js";
import { dayKey, getDailySalt } from "../src/lib/salt.js";
import { deploymentDid } from "../src/lib/signing.js";

const SITE = "77777777-7777-4777-8777-777777777777";
const url = new URL("https://facet.example/api/event");
const NOW = Date.UTC(2026, 6, 15, 12);
const IP = "203.0.113.9";
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const baseInput = {
	siteId: SITE,
	ip: IP,
	ua: UA,
	hostname: "shop.example.com",
	path: "/",
	referrer: "",
	name: null,
	props: null,
	utm: null,
	country: null,
	device: "desktop",
	now: NOW,
	gpc: false,
	url: url,
	uid: null,
	consent: false,
};

async function storedHashes(e: typeof env): Promise<string[]> {
	const rows = await e.DB.prepare(
		"SELECT visitor_hash FROM events WHERE site_id = ?",
	)
		.bind(SITE)
		.all<{ visitor_hash: string }>();
	return rows.results.map((r) => r.visitor_hash);
}

async function elevate(e: typeof env): Promise<void> {
	await e.DB.prepare(
		"INSERT OR REPLACE INTO site_config (site_id, tier, salt_window, updated_at) VALUES (?, ?, ?, ?)",
	)
		.bind(SITE, "pseudonymous", "week", NOW)
		.run();
}

describe("ingestEvent under the identity spectrum", () => {
	it("a zero-config site writes the legacy Tier-0 hash (no-op)", async () => {
		const res = await ingestEvent(env, baseInput);
		expect(res.inserted).toBe(true);
		const legacy = await visitorHash(
			IP,
			UA,
			await getDailySalt(env, dayKey(NOW), NOW),
			SITE,
		);
		expect(await storedHashes(env)).toEqual([legacy]);
	});

	it("drops a GPC visitor inside ingestEvent (structural backstop)", async () => {
		const res = await ingestEvent(env, { ...baseInput, gpc: true });
		expect(res.inserted).toBe(false);
		expect(await storedHashes(env)).toEqual([]);
	});

	describe("elevated site", () => {
		let signingEnv: typeof env & { FACET_SIGNING_JWK: string };

		beforeEach(async () => {
			const gen = await generateSigningJwk("EdDSA");
			signingEnv = {
				...env,
				FACET_SIGNING_JWK: JSON.stringify(gen.privateJwk),
			};
			await elevate(signingEnv);
		});

		it("writes the windowed hash when a valid consent record exists", async () => {
			const wk = windowKey("week", NOW);
			const scope = `${SITE}:week:${wk}`;
			const salt = await getScopedSalt(
				signingEnv,
				scope,
				"week",
				windowEndMs("week", NOW),
				NOW,
			);
			const vh = await deriveVisitorHash(
				"pseudonymous",
				{ ip: IP, ua: UA },
				salt,
				SITE,
			);
			const key = await loadSigningKey(signingEnv.FACET_SIGNING_JWK);
			const stmt = await signConsent(
				key,
				{
					iss: deploymentDid(url),
					site_id: SITE,
					visitor_hash: vh,
					tier: "pseudonymous",
					salt_window: "week",
					window_key: wk,
					external_user_id_present: false,
					gpc_at_grant: 0,
					granted_at: new Date(NOW).toISOString(),
				},
				NOW,
			);
			await storeConsentRecord(signingEnv, {
				id: crypto.randomUUID(),
				siteId: SITE,
				visitorHash: vh,
				tier: "pseudonymous",
				externalUserId: null,
				saltWindow: "week",
				windowKey: wk,
				gpcAtGrant: 0,
				grantedAt: NOW,
				expiresAt: null,
				statement: stmt,
			});

			await ingestEvent(signingEnv, baseInput);
			const dayHash = await visitorHash(
				IP,
				UA,
				await getDailySalt(signingEnv, dayKey(NOW), NOW),
				SITE,
			);
			expect(await storedHashes(signingEnv)).toEqual([vh]);
			expect(vh).not.toBe(dayHash); // genuinely the windowed pseudonym, not the day hash
		});

		it("downgrades to the Tier-0 day hash when there is no consent", async () => {
			await ingestEvent(signingEnv, baseInput);
			const dayHash = await visitorHash(
				IP,
				UA,
				await getDailySalt(signingEnv, dayKey(NOW), NOW),
				SITE,
			);
			expect(await storedHashes(signingEnv)).toEqual([dayHash]);
		});
	});
});
