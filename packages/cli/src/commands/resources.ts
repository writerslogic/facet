// Admin-API resource commands (sites, keys, goals, funnels, experiments). The admin token only ever
// travels in the Authorization header, never printed. Newly issued key plaintext is the sole secret
// written to stdout, and only once with a warning.

import { parseArgs } from 'node:util';
import type {
	ApiKeyRecord,
	Experiment,
	ExperimentVariant,
	Funnel,
	FunnelStep,
	Goal,
	Site,
} from '@facet/shared';
import pc from 'picocolors';
import {
	type AdminClient,
	type FetchJson,
	UsageError,
	adminClient,
	renderTable,
	requireString,
	requireUuid,
	resolveAdminToken,
	resolveHost,
} from '../admin.js';
import { fetchJson, printError } from '../util.js';

const COMMON = {
	host: { type: 'string' },
	'admin-token': { type: 'string' },
	json: { type: 'boolean' },
} as const;

type Values = Record<string, string | boolean | undefined>;

/** Build an admin client from parsed common flags; throws UsageError on missing host/token. */
function client(values: Values, fetchImpl: FetchJson): AdminClient {
	const host = resolveHost(values.host as string | undefined);
	const token = resolveAdminToken(values['admin-token'] as string | undefined);
	return adminClient(host, token, fetchImpl);
}

function emitJson(value: unknown): number {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
	return 0;
}

function fmtTime(ms: number): string {
	return new Date(ms).toISOString();
}

// ── sites ──────────────────────────────────────────────────────────────────
async function sites(argv: string[], fetchImpl: FetchJson): Promise<number> {
	const [sub, ...rest] = argv;
	if (sub === 'list') {
		const { values } = parseArgs({
			args: rest,
			options: { ...COMMON },
			allowPositionals: false,
		});
		const api = client(values, fetchImpl);
		const { sites } = await api.get<{ sites: Site[] }>('/api/sites');
		if (values.json) return emitJson(sites);
		process.stdout.write(
			renderTable(
				['ID', 'NAME', 'DOMAIN', 'CREATED'],
				sites.map((s) => [s.id, s.name, s.domain, fmtTime(s.created_at)]),
			),
		);
		return 0;
	}
	if (sub === 'create') {
		const { values } = parseArgs({
			args: rest,
			options: {
				...COMMON,
				name: { type: 'string' },
				domain: { type: 'string' },
			},
			allowPositionals: false,
		});
		const name = requireString('name', values.name);
		const domain = requireString('domain', values.domain);
		const api = client(values, fetchImpl);
		const { site } = await api.post<{ site: Site }>('/api/sites', {
			name,
			domain,
		});
		if (values.json) return emitJson(site);
		process.stdout.write(`Created site ${site.id} (${site.name} / ${site.domain}).\n`);
		return 0;
	}
	throw new UsageError('Usage: facet sites <list|create> [options]');
}

// ── keys ───────────────────────────────────────────────────────────────────
async function keys(argv: string[], fetchImpl: FetchJson): Promise<number> {
	const [sub, ...rest] = argv;
	if (sub === 'list') {
		const { values } = parseArgs({
			args: rest,
			options: { ...COMMON, site: { type: 'string' } },
			allowPositionals: false,
		});
		const site = requireUuid('site', values.site);
		const api = client(values, fetchImpl);
		const { keys } = await api.get<{ keys: ApiKeyRecord[] }>(`/api/keys?site_id=${site}`);
		if (values.json) return emitJson(keys);
		process.stdout.write(
			renderTable(
				['ID', 'LABEL', 'CREATED', 'LAST USED'],
				keys.map((k) => [
					k.id,
					k.label ?? '',
					fmtTime(k.created_at),
					k.last_used ? fmtTime(k.last_used) : 'never',
				]),
			),
		);
		return 0;
	}
	if (sub === 'issue') {
		const { values } = parseArgs({
			args: rest,
			options: {
				...COMMON,
				site: { type: 'string' },
				label: { type: 'string' },
			},
			allowPositionals: false,
		});
		const site = requireUuid('site', values.site);
		const api = client(values, fetchImpl);
		const body: { site_id: string; label?: string } = { site_id: site };
		if (values.label) body.label = values.label as string;
		const issued = await api.post<{ id: string; key: string }>('/api/keys', body);
		if (values.json) return emitJson(issued);
		process.stdout.write(`Issued key ${issued.id}.\n`);
		process.stdout.write(
			`${pc.yellow('This key is shown once and cannot be retrieved again:')}\n`,
		);
		process.stdout.write(`  ${issued.key}\n`);
		return 0;
	}
	if (sub === 'revoke') {
		const { values } = parseArgs({
			args: rest,
			options: {
				...COMMON,
				id: { type: 'string' },
				site: { type: 'string' },
			},
			allowPositionals: false,
		});
		const id = requireUuid('id', values.id);
		const site = requireUuid('site', values.site);
		const api = client(values, fetchImpl);
		await api.delete<{ deleted: true }>(`/api/keys/${id}?site_id=${site}`);
		if (values.json) return emitJson({ deleted: true, id });
		process.stdout.write(`Revoked key ${id}.\n`);
		return 0;
	}
	throw new UsageError('Usage: facet keys <list|issue|revoke> [options]');
}

// ── goals ──────────────────────────────────────────────────────────────────
async function goals(argv: string[], fetchImpl: FetchJson): Promise<number> {
	const [sub, ...rest] = argv;
	if (sub === 'list') {
		const { values } = parseArgs({
			args: rest,
			options: { ...COMMON, site: { type: 'string' } },
			allowPositionals: false,
		});
		const site = requireUuid('site', values.site);
		const api = client(values, fetchImpl);
		const { goals } = await api.get<{ goals: Goal[] }>(`/api/goals?site_id=${site}`);
		if (values.json) return emitJson(goals);
		process.stdout.write(
			renderTable(
				['ID', 'NAME', 'TYPE', 'MATCH'],
				goals.map((g) => [g.id, g.name, g.type, g.match_value]),
			),
		);
		return 0;
	}
	if (sub === 'create') {
		const { values } = parseArgs({
			args: rest,
			options: {
				...COMMON,
				site: { type: 'string' },
				name: { type: 'string' },
				type: { type: 'string' },
				match: { type: 'string' },
			},
			allowPositionals: false,
		});
		const site = requireUuid('site', values.site);
		const name = requireString('name', values.name);
		const type = requireString('type', values.type);
		if (type !== 'event' && type !== 'path') {
			throw new UsageError('Invalid --type: expected "event" or "path".');
		}
		const match = requireString('match', values.match);
		const api = client(values, fetchImpl);
		const { goal } = await api.post<{ goal: Goal }>('/api/goals', {
			site_id: site,
			name,
			type,
			match_value: match,
		});
		if (values.json) return emitJson(goal);
		process.stdout.write(`Created goal ${goal.id} (${goal.name}).\n`);
		return 0;
	}
	if (sub === 'delete') {
		const { values } = parseArgs({
			args: rest,
			options: {
				...COMMON,
				id: { type: 'string' },
				site: { type: 'string' },
			},
			allowPositionals: false,
		});
		const id = requireUuid('id', values.id);
		const site = requireUuid('site', values.site);
		const api = client(values, fetchImpl);
		await api.delete<{ deleted: true }>(`/api/goals/${id}?site_id=${site}`);
		if (values.json) return emitJson({ deleted: true, id });
		process.stdout.write(`Deleted goal ${id}.\n`);
		return 0;
	}
	throw new UsageError('Usage: facet goals <list|create|delete> [options]');
}

// ── funnels ────────────────────────────────────────────────────────────────
function parseJsonFlag<T>(flag: string, raw: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new UsageError(`Invalid --${flag}: not valid JSON.`);
	}
}

async function funnels(argv: string[], fetchImpl: FetchJson): Promise<number> {
	const [sub, ...rest] = argv;
	if (sub === 'list') {
		const { values } = parseArgs({
			args: rest,
			options: { ...COMMON, site: { type: 'string' } },
			allowPositionals: false,
		});
		const site = requireUuid('site', values.site);
		const api = client(values, fetchImpl);
		const { funnels } = await api.get<{ funnels: Funnel[] }>(`/api/funnels?site_id=${site}`);
		if (values.json) return emitJson(funnels);
		process.stdout.write(
			renderTable(
				['ID', 'NAME', 'STEPS'],
				funnels.map((f) => [f.id, f.name, String(f.steps.length)]),
			),
		);
		return 0;
	}
	if (sub === 'create') {
		const { values } = parseArgs({
			args: rest,
			options: {
				...COMMON,
				site: { type: 'string' },
				name: { type: 'string' },
				steps: { type: 'string' },
			},
			allowPositionals: false,
		});
		const site = requireUuid('site', values.site);
		const name = requireString('name', values.name);
		const stepsRaw = requireString('steps', values.steps);
		const steps = parseJsonFlag<FunnelStep[]>('steps', stepsRaw);
		if (!Array.isArray(steps) || steps.length < 2) {
			throw new UsageError('Invalid --steps: expected a JSON array of at least 2 steps.');
		}
		const api = client(values, fetchImpl);
		const { funnel } = await api.post<{ funnel: Funnel }>('/api/funnels', {
			site_id: site,
			name,
			steps,
		});
		if (values.json) return emitJson(funnel);
		process.stdout.write(`Created funnel ${funnel.id} (${funnel.name}).\n`);
		return 0;
	}
	if (sub === 'delete') {
		const { values } = parseArgs({
			args: rest,
			options: {
				...COMMON,
				id: { type: 'string' },
				site: { type: 'string' },
			},
			allowPositionals: false,
		});
		const id = requireUuid('id', values.id);
		const site = requireUuid('site', values.site);
		const api = client(values, fetchImpl);
		await api.delete<{ deleted: true }>(`/api/funnels/${id}?site_id=${site}`);
		if (values.json) return emitJson({ deleted: true, id });
		process.stdout.write(`Deleted funnel ${id}.\n`);
		return 0;
	}
	throw new UsageError('Usage: facet funnels <list|create|delete> [options]');
}

// ── experiments ──────────────────────────────────────────────────────────────
async function experiments(argv: string[], fetchImpl: FetchJson): Promise<number> {
	const [sub, ...rest] = argv;
	if (sub === 'list') {
		const { values } = parseArgs({
			args: rest,
			options: { ...COMMON, site: { type: 'string' } },
			allowPositionals: false,
		});
		const site = requireUuid('site', values.site);
		const api = client(values, fetchImpl);
		const { experiments } = await api.get<{ experiments: Experiment[] }>(
			`/api/experiments?site_id=${site}`,
		);
		if (values.json) return emitJson(experiments);
		process.stdout.write(
			renderTable(
				['ID', 'NAME', 'FLAG', 'VARIANTS', 'ACTIVE'],
				experiments.map((e) => [
					e.id,
					e.name,
					e.flag_key,
					e.variants.map((v) => v.key).join(','),
					e.active ? 'yes' : 'no',
				]),
			),
		);
		return 0;
	}
	if (sub === 'create') {
		const { values } = parseArgs({
			args: rest,
			options: {
				...COMMON,
				site: { type: 'string' },
				name: { type: 'string' },
				flag: { type: 'string' },
				variants: { type: 'string' },
			},
			allowPositionals: false,
		});
		const site = requireUuid('site', values.site);
		const name = requireString('name', values.name);
		const flag = requireString('flag', values.flag);
		const variantsRaw = requireString('variants', values.variants);
		const variants = parseJsonFlag<ExperimentVariant[]>('variants', variantsRaw);
		if (!Array.isArray(variants) || variants.length < 2) {
			throw new UsageError(
				'Invalid --variants: expected a JSON array of at least 2 variants.',
			);
		}
		const api = client(values, fetchImpl);
		const { experiment } = await api.post<{ experiment: Experiment }>('/api/experiments', {
			site_id: site,
			name,
			flag_key: flag,
			variants,
		});
		if (values.json) return emitJson(experiment);
		process.stdout.write(`Created experiment ${experiment.id} (${experiment.name}).\n`);
		return 0;
	}
	if (sub === 'delete') {
		const { values } = parseArgs({
			args: rest,
			options: {
				...COMMON,
				id: { type: 'string' },
				site: { type: 'string' },
			},
			allowPositionals: false,
		});
		const id = requireUuid('id', values.id);
		const site = requireUuid('site', values.site);
		const api = client(values, fetchImpl);
		await api.delete<{ deleted: true }>(`/api/experiments/${id}?site_id=${site}`);
		if (values.json) return emitJson({ deleted: true, id });
		process.stdout.write(`Deleted experiment ${id}.\n`);
		return 0;
	}
	throw new UsageError('Usage: facet experiments <list|create|delete> [options]');
}

const GROUPS: Record<string, (argv: string[], fetchImpl: FetchJson) => Promise<number>> = {
	sites,
	keys,
	goals,
	funnels,
	experiments,
};

/** True if `command` names a resource group handled here. */
export function isResourceCommand(command: string): boolean {
	return command in GROUPS;
}

/** Dispatch a resource group command. Maps UsageError / request failures to a nonzero exit. */
export async function runResource(
	command: string,
	argv: string[],
	fetchImpl: FetchJson = fetchJson,
): Promise<number> {
	const handler = GROUPS[command];
	if (!handler) {
		printError(`Unknown resource command: ${command}`);
		return 1;
	}
	try {
		return await handler(argv, fetchImpl);
	} catch (err) {
		if (err instanceof UsageError) {
			printError(err.message);
			return 1;
		}
		printError(
			`${command} request failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}
}
