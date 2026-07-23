// GET /api/stats: authed read returns the assembled response; enforces site scope, range
// validity, and the max range.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type NewEvent, insertEvent } from "../src/db/queries.js";
import { issueKey } from "../src/lib/apikeys.js";
import { DAY_MS, HOUR_MS } from "../src/lib/constants.js";

const SITE = "11111111-1111-4111-8111-111111111111";
const SITE2 = "22222222-2222-4222-8222-222222222222";
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

let apiKey: string;

function mk(
	path: string,
	device: string,
	country: string,
	name: string | null,
	visitor: string,
	offset: number,
): NewEvent {
	return {
		siteId: SITE,
		hostname: "x.example.com",
		path,
		referrer: "",
		name,
		props: null,
		visitorHash: visitor,
		country,
		device,
		createdAt: T0 + offset,
	};
}

function get(qs: string, key: string | null) {
	return createApp().request(
		`/api/stats?${qs}`,
		key ? { headers: { Authorization: `Bearer ${key}` } } : {},
		env,
	);
}

beforeEach(async () => {
	const issued = await issueKey(env, SITE, null, Date.now());
	apiKey = issued.key;
	for (const row of [
		mk("/", "desktop", "US", null, "v1", 0),
		mk("/", "desktop", "US", null, "v1", 0),
		mk("/p", "mobile", "GB", null, "v2", 1000),
		mk("/", "desktop", "US", "signup", "v1", 2000),
	]) {
		await insertEvent(env, row);
	}
});

describe("GET /api/stats", () => {
	it("returns the assembled stats for the authed site", async () => {
		const res = await get(
			`site_id=${SITE}&start=${T0}&end=${T0 + 2 * HOUR_MS}`,
			apiKey,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			summary: { pageviews: number; events: number; visitors: number };
			series: unknown[];
			top_paths: { key: string; count: number }[];
			top_countries: { key: string; count: number }[];
			top_devices: { key: string; count: number }[];
		};
		expect(body.summary).toEqual({ pageviews: 3, events: 1, visitors: 2 });
		expect(body.series.length).toBeGreaterThan(0);
		expect(body.top_paths).toContainEqual({ key: "/", count: 3 });
		expect(body.top_countries).toContainEqual({ key: "US", count: 3 });
		expect(body.top_devices).toContainEqual({ key: "desktop", count: 3 });
	});

	it("rejects a key scoped to a different site with 403 site_mismatch", async () => {
		const res = await get(
			`site_id=${SITE2}&start=${T0}&end=${T0 + HOUR_MS}`,
			apiKey,
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "site_mismatch" });
	});

	it("rejects missing auth with 401 invalid_api_key", async () => {
		const res = await get(
			`site_id=${SITE}&start=${T0}&end=${T0 + HOUR_MS}`,
			null,
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "invalid_api_key" });
	});

	it("rejects end <= start with 400 bad_range", async () => {
		const res = await get(`site_id=${SITE}&start=${T0}&end=${T0}`, apiKey);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "bad_range" });
	});

	it("rejects a range over 90 days with 400 range_too_large", async () => {
		const res = await get(
			`site_id=${SITE}&start=${T0}&end=${T0 + 91 * DAY_MS}`,
			apiKey,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "range_too_large" });
	});
});

type FilteredBody = {
	summary: { pageviews: number; events: number; visitors: number };
	series: { pageviews: number; visitors: number }[];
	top_paths: { key: string; count: number }[];
	top_countries: { key: string; count: number }[];
	top_devices: { key: string; count: number }[];
};

describe("GET /api/stats dimension filters", () => {
	const RANGE = `start=${T0}&end=${T0 + 2 * HOUR_MS}`;

	it("device=mobile narrows summary, series, and breakdowns to the matching rows", async () => {
		const res = await get(`site_id=${SITE}&${RANGE}&device=mobile`, apiKey);
		expect(res.status).toBe(200);
		const body = (await res.json()) as FilteredBody;
		// Only the single /p GB mobile pageview matches.
		expect(body.summary).toEqual({ pageviews: 1, events: 0, visitors: 1 });
		expect(body.series.reduce((n, p) => n + p.pageviews, 0)).toBe(1);
		expect(body.top_paths).toEqual([{ key: "/p", count: 1 }]);
		expect(body.top_countries).toEqual([{ key: "GB", count: 1 }]);
		expect(body.top_devices).toEqual([{ key: "mobile", count: 1 }]);
	});

	it("path=/ narrows to the desktop US rows only", async () => {
		const res = await get(
			`site_id=${SITE}&${RANGE}&path=${encodeURIComponent("/")}`,
			apiKey,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as FilteredBody;
		// The three `/` rows (2 pageviews + 1 signup event), all visitor v1, all desktop/US.
		expect(body.summary).toEqual({ pageviews: 2, events: 1, visitors: 1 });
		expect(body.series.reduce((n, p) => n + p.pageviews, 0)).toBe(2);
		expect(body.top_paths).toEqual([{ key: "/", count: 3 }]);
		expect(body.top_devices).toEqual([{ key: "desktop", count: 3 }]);
		expect(body.top_countries).toEqual([{ key: "US", count: 3 }]);
	});

	it("country=US and country=GB partition the pageviews", async () => {
		const [usRes, gbRes] = await Promise.all([
			get(`site_id=${SITE}&${RANGE}&country=US`, apiKey),
			get(`site_id=${SITE}&${RANGE}&country=GB`, apiKey),
		]);
		const [us, gb] = await Promise.all([usRes.json(), gbRes.json()]);
		expect((us as FilteredBody).summary).toEqual({
			pageviews: 2,
			events: 1,
			visitors: 1,
		});
		expect((gb as FilteredBody).summary).toEqual({
			pageviews: 1,
			events: 0,
			visitors: 1,
		});
	});

	it("an absent filter is unchanged (no regression)", async () => {
		const res = await get(`site_id=${SITE}&${RANGE}`, apiKey);
		expect(res.status).toBe(200);
		const body = (await res.json()) as FilteredBody;
		expect(body.summary).toEqual({ pageviews: 3, events: 1, visitors: 2 });
		expect(body.top_paths).toContainEqual({ key: "/", count: 3 });
		expect(body.top_paths).toContainEqual({ key: "/p", count: 1 });
	});
});
