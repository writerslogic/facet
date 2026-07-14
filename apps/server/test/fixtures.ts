import type { Env } from '../src/env.js';

export interface SeedSiteOverrides {
	readonly siteId?: string;
	readonly hostname?: string;
	readonly name?: string;
}

export interface SeedEventsOptions {
	readonly siteId: string;
	readonly count: number;
	readonly baseTs: number;
	readonly hostname?: string;
	readonly path?: string;
	readonly referrer?: string;
	readonly name?: string;
	readonly device?: string;
	readonly country?: string;
	readonly spanMs?: number;
}

export async function seedSite(
	env: Env,
	overrides: SeedSiteOverrides = {},
): Promise<{ siteId: string; hostname: string }> {
	const siteId = overrides.siteId ?? crypto.randomUUID();
	const hostname = overrides.hostname ?? `${siteId}.example.com`;
	const name = overrides.name ?? 'Test Site';

	await env.DB.prepare('INSERT INTO sites (id, domain, name, created_at) VALUES (?, ?, ?, ?)')
		.bind(siteId, hostname, name, Date.now())
		.run();

	return { siteId, hostname };
}

export async function seedEvents(env: Env, opts: SeedEventsOptions): Promise<void> {
	const {
		siteId,
		count,
		baseTs,
		hostname = 'example.com',
		path = '/',
		referrer = '',
		name = 'pageview',
		device = 'desktop',
		country = 'US',
		spanMs = 0,
	} = opts;

	const step = spanMs > 0 && count > 1 ? Math.floor(spanMs / (count - 1)) : 0;

	const stmt = env.DB.prepare(
		`INSERT INTO events (id, site_id, name, hostname, path, referrer, device, country, visitor_hash, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	const batch = Array.from({ length: count }, (_, i) => {
		const ts = baseTs + i * step;
		const visitorHash = `fixture-visitor-${siteId}-${i}`;
		return stmt.bind(
			crypto.randomUUID(),
			siteId,
			name,
			hostname,
			path,
			referrer,
			device,
			country,
			visitorHash,
			ts,
		);
	});

	await env.DB.batch(batch);
}
