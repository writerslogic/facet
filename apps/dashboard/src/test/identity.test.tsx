// IdentityPanel: sets a site's identity tier + salt window via PATCH /api/sites/:id/identity. The
// admin token is carried as a bearer and never appears in the URL. `anonymous` forces the day window;
// the server's 501 identity_signing_unconfigured surfaces as a friendly "signing key required" message.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityPanel } from '../components/settings/IdentityPanel.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'admintoken-secret';

interface Call {
	url: string;
	method: string;
	auth: string | null;
	body: unknown;
}

let calls: Call[] = [];
let nextResponse: {
	ok: boolean;
	status?: number;
	json: () => Promise<unknown>;
} = {
	ok: true,
	json: async () => ({
		identity: { site_id: SITE, tier: 'pseudonymous', salt_window: 'week' },
	}),
};

function mockFetch() {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = init?.method ?? 'GET';
		const auth =
			init?.headers && typeof init.headers === 'object'
				? ((init.headers as Record<string, string>).Authorization ?? null)
				: null;
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		calls.push({ url, method, auth, body });
		return nextResponse;
	});
}

function renderPanel() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<IdentityPanel token={TOKEN} siteId={SITE} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	calls = [];
	nextResponse = {
		ok: true,
		json: async () => ({
			identity: {
				site_id: SITE,
				tier: 'pseudonymous',
				salt_window: 'week',
			},
		}),
	};
	vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('IdentityPanel', () => {
	it('defaults to anonymous with the salt window forced to day', () => {
		renderPanel();
		const tier = screen.getByLabelText('Tier') as HTMLSelectElement;
		const window = screen.getByLabelText('Salt window') as HTMLSelectElement;
		expect(tier.value).toBe('anonymous');
		expect(window.value).toBe('day');
		expect(window).toBeDisabled();
	});

	it('PATCHes the chosen tier + salt window with the bearer token, not in the URL', async () => {
		renderPanel();
		fireEvent.change(screen.getByLabelText('Tier'), {
			target: { value: 'pseudonymous' },
		});
		fireEvent.change(screen.getByLabelText('Salt window'), {
			target: { value: 'week' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Set identity' }));

		await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
		const patch = calls.find((c) => c.method === 'PATCH');
		expect(patch?.url).toBe(`/api/sites/${SITE}/identity`);
		expect(patch?.url).not.toContain(TOKEN);
		expect(patch?.auth).toBe(`Bearer ${TOKEN}`);
		expect(patch?.body).toMatchObject({
			tier: 'pseudonymous',
			salt_window: 'week',
		});
		await waitFor(() =>
			expect(screen.getByText(/Identity set to pseudonymous/)).toBeInTheDocument(),
		);
	});

	it('sends the day window when tier is anonymous even after picking another window', async () => {
		renderPanel();
		// Elevate, choose month, then return to anonymous — the window must be clamped back to day.
		fireEvent.change(screen.getByLabelText('Tier'), {
			target: { value: 'identified' },
		});
		fireEvent.change(screen.getByLabelText('Salt window'), {
			target: { value: 'month' },
		});
		fireEvent.change(screen.getByLabelText('Tier'), {
			target: { value: 'anonymous' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Set identity' }));

		await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
		const patch = calls.find((c) => c.method === 'PATCH');
		expect(patch?.body).toMatchObject({
			tier: 'anonymous',
			salt_window: 'day',
		});
	});

	it('surfaces a friendly message on 501 identity_signing_unconfigured', async () => {
		nextResponse = {
			ok: false,
			status: 501,
			json: async () => ({ error: 'identity_signing_unconfigured' }),
		};
		renderPanel();
		fireEvent.change(screen.getByLabelText('Tier'), {
			target: { value: 'pseudonymous' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Set identity' }));

		await waitFor(() =>
			expect(screen.getByText(/deployment signing key is required/)).toBeInTheDocument(),
		);
	});
});
