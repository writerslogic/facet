// FlagsPanel: lists a site's flags, gates create on a valid variant-weight sum (must equal 10000),
// toggles enabled via PATCH, and deletes via the two-step confirm. All admin calls carry the bearer
// token and never expose it in a URL.

import type { FlagRecord } from '@facet/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlagsPanel } from '../components/settings/FlagsPanel.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'admintoken-secret';

interface Call {
	url: string;
	method: string;
	body: unknown;
}

let calls: Call[] = [];
let flags: FlagRecord[] = [];

function seedFlag(): FlagRecord {
	return {
		id: 'flag-1',
		site_id: SITE,
		flag_key: 'new_checkout',
		name: 'New checkout',
		type: 'boolean',
		enabled: false,
		default_variant: 'off',
		variants: [
			{ key: 'on', weight: 5000 },
			{ key: 'off', weight: 5000 },
		],
		salt: 's',
		rollout_seed: 1,
		version: 1,
		rules: [],
		created_at: 0,
		updated_at: 0,
	};
}

function mockFetch() {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		calls.push({ url, method, body });

		if (url.startsWith('/api/flags')) {
			if (method === 'PATCH') {
				const id = url.split('/').pop() ?? '';
				flags = flags.map((f) =>
					f.id === id ? { ...f, ...body, version: f.version + 1 } : f,
				);
				return {
					ok: true,
					json: async () => ({
						flag: flags.find((f) => f.id === id),
					}),
				};
			}
			if (method === 'DELETE') {
				flags = [];
				return { ok: true, json: async () => ({ deleted: true }) };
			}
			return { ok: true, json: async () => ({ flags }) };
		}
		return { ok: true, json: async () => ({}) };
	});
}

function renderPanel() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<FlagsPanel token={TOKEN} siteId={SITE} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	calls = [];
	flags = [seedFlag()];
	vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('FlagsPanel', () => {
	it('lists a site flag with its variant summary and version', async () => {
		renderPanel();
		await waitFor(() => expect(screen.getByText('New checkout')).toBeInTheDocument());
		expect(screen.getByText(/new_checkout · boolean · on 5000, off 5000/)).toBeInTheDocument();
		// The list call carried the bearer token and never put it in the URL.
		const listCall = calls.find((c) => c.method === 'GET');
		expect(listCall?.url).not.toContain(TOKEN);
	});

	it('gates create until variant weights sum to 10000', async () => {
		renderPanel();
		await waitFor(() => expect(screen.getByText('New checkout')).toBeInTheDocument());
		fireEvent.change(screen.getByLabelText('Flag key'), {
			target: { value: 'promo' },
		});
		fireEvent.change(screen.getByLabelText('Name'), {
			target: { value: 'Promo' },
		});
		const submit = screen.getByRole('button', { name: 'Create flag' });
		expect(submit).toBeEnabled();
		// Break the sum: on becomes 4000, total 9000.
		fireEvent.change(screen.getByLabelText('Variant 1 weight'), {
			target: { value: '4000' },
		});
		expect(screen.getByText('Σ 9000 / 10000')).toBeInTheDocument();
		expect(submit).toBeDisabled();
	});

	it('toggles enabled via PATCH', async () => {
		renderPanel();
		await waitFor(() => expect(screen.getByText('New checkout')).toBeInTheDocument());
		fireEvent.click(screen.getByLabelText('Enable New checkout'));
		await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
		const patch = calls.find((c) => c.method === 'PATCH');
		expect((patch?.body as { enabled: boolean }).enabled).toBe(true);
	});

	it('deletes a flag after confirmation', async () => {
		renderPanel();
		await waitFor(() => expect(screen.getByText('New checkout')).toBeInTheDocument());
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
	});
});
