// CRM tab. The four behaviours here are correctness, not polish:
//   1. A deployment with no CRM database (501) explains itself instead of erroring — that is the
//      DEFAULT state, so an alert or a crash there would be the common experience, not the rare one.
//   2. A contact with no consent-authorized link renders as NOT LINKED with its reason. Zeroes would
//      assert "this person did nothing", which is a different and false claim.
//   3. A company rollup always states its denominator: "1 of 12 contacts linked", plus a lower-bound
//      warning when the API truncated the fan-out.
//   4. Delete and export appear only for an operator whose role provably includes `admin`, and the
//      contact confirmation says that erasure also destroys consent records.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Crm } from '../components/Crm.js';

const SITE = '11111111-1111-4111-8111-111111111111';

const CONTACT = {
	id: 'c1',
	site_id: SITE,
	external_user_id: null,
	email: 'ada@example.com',
	name: 'Ada Lovelace',
	phone: null,
	company: 'Acme Inc',
	company_id: 'co1',
	title: 'Engineer',
	status: 'active',
	source: null,
	notes: null,
	owner_user_id: null,
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
};

const COMPANY = {
	id: 'co1',
	site_id: SITE,
	name: 'Acme Inc',
	domain: 'acme.com',
	status: 'active',
	notes: null,
	owner_user_id: null,
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
};

const DEAL = {
	id: 'd1',
	site_id: SITE,
	name: 'Acme Inc — annual plan',
	company_id: 'co1',
	contact_id: 'c1',
	stage: 'proposal',
	value: 490000,
	currency: 'USD',
	expected_close_date: 1_700_100_000_000,
	notes: null,
	owner_user_id: null,
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
};

interface Handlers {
	/** The role the server reports on each list response — the only authoritative source, since no
	 * session-reachable route maps a site to its owning team. Undefined means the field is absent,
	 * which must read as "not an admin" rather than as permission. */
	role?: string;
	contactAnalytics?: unknown;
	companyAnalytics?: unknown;
	pipeline?: unknown[];
	contactDeleteResult?: { consent_records_erased: number; deals_unlinked: number };
	companyDeleteResult?: { contacts_unlinked: number; deals_unlinked: number };
}

/** Every /api/* response the CRM tab can ask for, unless `unavailable` short-circuits them all.
 * Returns the underlying `vi.fn` so a test can inspect the body a write actually sent — the whole
 * point of the `sends the value as a real number` test below. */
function mockApi(handlers: Handlers & { unavailable?: boolean } = {}) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String(input);
		if (handlers.unavailable && url.startsWith('/api/crm')) {
			return { ok: false, status: 501, json: async () => ({ error: 'crm_unavailable' }) };
		}
		if (url.includes('/analytics')) {
			const body = url.includes('/companies/')
				? handlers.companyAnalytics
				: handlers.contactAnalytics;
			return { ok: true, status: 200, json: async () => body ?? {} };
		}
		if (url.startsWith('/api/crm/companies/') && url.includes('/contacts')) {
			return { ok: true, status: 200, json: async () => ({ contacts: [], total: 0 }) };
		}
		if (url.startsWith('/api/crm/companies/') && init?.method === 'DELETE') {
			const result = handlers.companyDeleteResult ?? {
				contacts_unlinked: 0,
				deals_unlinked: 0,
			};
			return { ok: true, status: 200, json: async () => ({ deleted: true, ...result }) };
		}
		if (url.startsWith('/api/crm/companies/')) {
			return { ok: true, status: 200, json: async () => ({ company: COMPANY }) };
		}
		if (url.startsWith('/api/crm/companies')) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ companies: [COMPANY], total: 1, role: handlers.role }),
			};
		}
		if (url.startsWith('/api/crm/pipeline')) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ pipeline: handlers.pipeline ?? [] }),
			};
		}
		if (url.startsWith('/api/crm/deals') && init?.method === 'POST') {
			// Echoes the submitted body back as the created deal, so a test can assert on what the
			// form actually sent (a real number, not the stringified one the API would 400 on).
			const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
			return { ok: true, status: 201, json: async () => ({ deal: { ...DEAL, ...sent } }) };
		}
		if (url.startsWith('/api/crm/deals/')) {
			return { ok: true, status: 200, json: async () => ({ deal: DEAL }) };
		}
		if (url.startsWith('/api/crm/deals')) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ deals: [DEAL], total: 1, role: handlers.role }),
			};
		}
		if (url.startsWith('/api/crm/contacts/') && init?.method === 'DELETE') {
			const result = handlers.contactDeleteResult ?? {
				consent_records_erased: 0,
				deals_unlinked: 0,
			};
			return { ok: true, status: 200, json: async () => ({ deleted: true, ...result }) };
		}
		if (url.startsWith('/api/crm/contacts/')) {
			return { ok: true, status: 200, json: async () => ({ contact: CONTACT }) };
		}
		return {
			ok: true,
			status: 200,
			json: async () => ({ contacts: [CONTACT], total: 1, role: handlers.role }),
		};
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function renderCrm() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<Crm siteId={SITE} />
		</QueryClientProvider>,
	);
}

/** Open the contact detail pane, which is where the analytics and the admin controls live. */
async function openContact(): Promise<void> {
	fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }));
	await screen.findByRole('heading', { name: 'Analytics' });
}

async function openCompany(): Promise<void> {
	fireEvent.click(screen.getByRole('tab', { name: 'Companies' }));
	fireEvent.click(await screen.findByRole('button', { name: 'Acme Inc' }));
	await screen.findByRole('heading', { name: 'Analytics rollup' });
}

/** Open the deal detail pane, which is where the value, links and admin controls live. Waits on the
 * detail heading rather than the "Value" label, which the roster's own column header also matches. */
async function openDeal(): Promise<void> {
	fireEvent.click(screen.getByRole('tab', { name: 'Deals' }));
	fireEvent.click(await screen.findByRole('button', { name: /annual plan/ }));
	await screen.findByRole('heading', { name: /annual plan/ });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('CRM tab without a CRM database', () => {
	it('explains the 501 instead of rendering an error', async () => {
		mockApi({ unavailable: true });
		renderCrm();

		expect(
			await screen.findByText(/CRM extension is not enabled on this deployment/i),
		).toBeInTheDocument();
		expect(screen.getByText(/CRM_DB/)).toBeInTheDocument();
		// Not an error and not retryable: nothing about an unbound database changes on a second try.
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
	});

	it('says the same thing on the companies section', async () => {
		mockApi({ unavailable: true });
		renderCrm();
		fireEvent.click(await screen.findByRole('tab', { name: 'Companies' }));
		expect(
			await screen.findByText(/CRM extension is not enabled on this deployment/i),
		).toBeInTheDocument();
	});
});

describe('contact analytics link', () => {
	it('renders an unlinked contact as not linked, with the reason and no zeroes', async () => {
		mockApi({
			role: 'analyst',
			contactAnalytics: { linked: false, reason: 'no_active_consent' },
		});
		renderCrm();
		await openContact();

		expect(await screen.findByText('Not linked to analytics')).toBeInTheDocument();
		expect(screen.getByText(/No active signed consent record/i)).toBeInTheDocument();
		expect(screen.getByText(/a report of zero activity/i)).toBeInTheDocument();
		// The figures must be absent entirely — a 0 next to "Pageviews" is the false claim.
		expect(screen.queryByText('Pageviews')).not.toBeInTheDocument();
		expect(screen.queryByText('Custom events')).not.toBeInTheDocument();
	});

	it('names a missing external user id as the reason when that is the cause', async () => {
		mockApi({
			role: 'analyst',
			contactAnalytics: { linked: false, reason: 'no_external_user_id' },
		});
		renderCrm();
		await openContact();

		expect(await screen.findByText(/no external user id/i)).toBeInTheDocument();
	});

	it('shows the figures when a link is authorized', async () => {
		mockApi({
			role: 'analyst',
			contactAnalytics: {
				linked: true,
				windows: 2,
				activity: {
					pageviews: 42,
					events: 3,
					total: 45,
					first_seen: 1_700_000_000_000,
					last_seen: 1_700_000_100_000,
					top_paths: [{ path: '/pricing', views: 12 }],
				},
			},
		});
		renderCrm();
		await openContact();

		expect(await screen.findByText('42')).toBeInTheDocument();
		expect(screen.getByText('/pricing')).toBeInTheDocument();
		expect(screen.queryByText('Not linked to analytics')).not.toBeInTheDocument();
	});
});

describe('company rollup', () => {
	it('states the denominator, so a partial rollup is never read as the whole account', async () => {
		mockApi({
			role: 'analyst',
			companyAnalytics: {
				contacts_total: 12,
				contacts_linked: 1,
				contacts_considered: 12,
				contacts_truncated: false,
				contacts_limit: 100,
				linked: true,
				visitor_hashes: 2,
				activity: {
					pageviews: 142,
					events: 3,
					total: 145,
					first_seen: 1_700_000_000_000,
					last_seen: 1_700_000_100_000,
					top_paths: [],
				},
			},
		});
		renderCrm();
		await openCompany();

		expect(await screen.findByText('1 of 12 contacts linked')).toBeInTheDocument();
		expect(screen.getByText(/not this company.s whole traffic/i)).toBeInTheDocument();
		expect(screen.getByText('142')).toBeInTheDocument();
	});

	it('flags a truncated rollup as a lower bound', async () => {
		mockApi({
			role: 'analyst',
			companyAnalytics: {
				contacts_total: 340,
				contacts_linked: 4,
				contacts_considered: 100,
				contacts_truncated: true,
				contacts_limit: 100,
				linked: false,
				reason: 'no_linked_contacts',
			},
		});
		renderCrm();
		await openCompany();

		expect(await screen.findByText('4 of 340 contacts linked')).toBeInTheDocument();
		expect(screen.getByText(/Lower bound, not a total/i)).toBeInTheDocument();
		// Still not zeroes: an unlinked rollup says so rather than reporting no traffic.
		expect(screen.getByText('Nothing here is linked to analytics')).toBeInTheDocument();
	});
});

describe('role-gated actions', () => {
	it('offers delete and export to an operator who provably holds admin', async () => {
		mockApi({
			role: 'admin',
			contactAnalytics: { linked: false, reason: 'no_active_consent' },
		});
		renderCrm();
		await openContact();

		const remove = await screen.findByRole('button', { name: 'Delete contact' });
		expect(screen.getByRole('button', { name: /Export this person/ })).toBeInTheDocument();

		// Confirming must state that consent records go too — the part an operator cannot guess.
		fireEvent.click(remove);
		expect(await screen.findByRole('alert')).toHaveTextContent(/consent records/i);
		expect(screen.getByRole('alert')).toHaveTextContent(/cannot be undone/i);
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
	});

	it('hides them from an analyst and says which role they need', async () => {
		mockApi({
			role: 'analyst',
			contactAnalytics: { linked: false, reason: 'no_active_consent' },
		});
		renderCrm();
		await openContact();

		expect(screen.queryByRole('button', { name: 'Delete contact' })).not.toBeInTheDocument();
		expect(
			screen.queryByRole('button', { name: /Export this person/ }),
		).not.toBeInTheDocument();
		expect(screen.getByText(/need the/i)).toHaveTextContent(/admin/i);
	});

	it('hides them when the server did not say what the role is', async () => {
		// An absent `role` is not permission. It reads as "not yet known", so the destructive action
		// stays hidden rather than being offered on a guess that would answer 403.
		mockApi({
			role: undefined,
			contactAnalytics: { linked: false, reason: 'no_active_consent' },
		});
		renderCrm();
		await openContact();

		expect(screen.queryByRole('button', { name: 'Delete contact' })).not.toBeInTheDocument();
	});

	it('hides the company delete from a non-admin and offers it to an admin', async () => {
		const analytics = {
			contacts_total: 0,
			contacts_linked: 0,
			contacts_considered: 0,
			contacts_truncated: false,
			contacts_limit: 100,
			linked: false,
			reason: 'no_linked_contacts',
		};
		mockApi({ role: 'analyst', companyAnalytics: analytics });
		const { unmount } = renderCrm();
		await openCompany();
		expect(screen.queryByRole('button', { name: 'Delete company' })).not.toBeInTheDocument();
		unmount();

		mockApi({ role: 'owner', companyAnalytics: analytics });
		renderCrm();
		await openCompany();
		fireEvent.click(await screen.findByRole('button', { name: 'Delete company' }));
		// Deleting a company must not read as deleting the people in it.
		await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/are kept/i));
		expect(screen.getByRole('alert')).toHaveTextContent(/unlinked/i);
	});

	it('reports deals unlinked alongside contacts when a company delete is confirmed', async () => {
		// Regression: useDeleteCompany's response type silently dropped deals_unlinked even though
		// the server has always returned it, so a company with attached deals never told the operator
		// those deals survived, unlinked, when it deleted the company.
		const analytics = {
			contacts_total: 0,
			contacts_linked: 0,
			contacts_considered: 0,
			contacts_truncated: false,
			contacts_limit: 100,
			linked: false,
			reason: 'no_linked_contacts',
		};
		mockApi({
			role: 'owner',
			companyAnalytics: analytics,
			companyDeleteResult: { contacts_unlinked: 2, deals_unlinked: 3 },
		});
		renderCrm();
		await openCompany();
		fireEvent.click(await screen.findByRole('button', { name: 'Delete company' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete company' }));

		expect(await screen.findByText(/2 contacts were unlinked and kept/i)).toBeInTheDocument();
		expect(screen.getByText(/3 deals were unlinked/i)).toBeInTheDocument();
	});

	it('reports deals unlinked alongside consent records when a contact delete is confirmed', async () => {
		mockApi({
			role: 'admin',
			contactAnalytics: { linked: false, reason: 'no_active_consent' },
			contactDeleteResult: { consent_records_erased: 1, deals_unlinked: 2 },
		});
		renderCrm();
		await openContact();
		fireEvent.click(await screen.findByRole('button', { name: 'Delete contact' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently' }));

		expect(await screen.findByText(/1 consent record/i)).toBeInTheDocument();
		expect(screen.getByText(/2 deals unlinked/i)).toBeInTheDocument();
	});

	it('treats a signed-out operator as having no admin capability', async () => {
		mockApi({ contactAnalytics: { linked: false, reason: 'no_active_consent' } });
		renderCrm();
		await openContact();

		expect(screen.queryByRole('button', { name: 'Delete contact' })).not.toBeInTheDocument();
	});
});

describe('viewing a company or contact’s deals', () => {
	it('jumps from a contact to its deals, filtered, with a banner naming it', async () => {
		mockApi({ role: 'analyst' });
		renderCrm();
		await openContact();
		fireEvent.click(await screen.findByRole('button', { name: 'Deals' }));

		expect(screen.getByRole('tab', { name: 'Deals', selected: true })).toBeInTheDocument();
		expect(await screen.findByText(/Showing deals for/i)).toHaveTextContent('Ada Lovelace');

		fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
		expect(screen.queryByText(/Showing deals for/i)).not.toBeInTheDocument();
	});

	it('jumps from a company to its deals, filtered, with a banner naming it', async () => {
		mockApi({
			role: 'analyst',
			companyAnalytics: { linked: false, reason: 'no_linked_contacts' },
		});
		renderCrm();
		await openCompany();
		fireEvent.click(await screen.findByRole('button', { name: 'Deals' }));

		expect(screen.getByRole('tab', { name: 'Deals', selected: true })).toBeInTheDocument();
		expect(await screen.findByText(/Showing deals for/i)).toHaveTextContent('Acme Inc');
	});
});

describe('deals', () => {
	it('submits value and expected close date as real numbers, not strings', async () => {
		// Regression: the create schema requires JSON numbers for these two fields and rejects an
		// empty-string currency outright, unlike the other CRM entities' clear-via-'' convention —
		// sending stringified values here 400s every create.
		const fetchMock = mockApi({ role: 'analyst' });
		renderCrm();
		fireEvent.click(screen.getByRole('tab', { name: 'Deals' }));
		fireEvent.click(await screen.findByRole('button', { name: 'New deal' }));

		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New opportunity' } });
		fireEvent.change(screen.getByLabelText('Value'), { target: { value: '99' } });
		fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'usd' } });
		fireEvent.change(screen.getByLabelText('Expected close date'), {
			target: { value: '2024-01-15' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create deal' }));

		await waitFor(() =>
			expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
		);
		const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST') ?? [];
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(body.value).toBe(9900);
		expect(typeof body.value).toBe('number');
		expect(body.currency).toBe('USD');
		expect(typeof body.expected_close_date).toBe('number');
	});

	it('shows the per-currency pipeline summary above the roster', async () => {
		mockApi({
			role: 'analyst',
			pipeline: [
				{
					currency: 'USD',
					open_value: 250000,
					open_count: 2,
					won_value: 120000,
					won_count: 1,
				},
			],
		});
		renderCrm();
		fireEvent.click(screen.getByRole('tab', { name: 'Deals' }));

		expect(await screen.findByText('USD')).toBeInTheDocument();
		expect(screen.getByText('$2,500.00')).toBeInTheDocument();
		expect(screen.getByText('$1,200.00')).toBeInTheDocument();
		expect(screen.getByText(/open · 2/)).toBeInTheDocument();
		expect(screen.getByText(/won · 1/)).toBeInTheDocument();
	});

	it('lists a deal with its formatted value and stage, and opens its detail', async () => {
		mockApi({ role: 'analyst' });
		renderCrm();
		await openDeal();

		// Appears twice by design: once in the roster row, once in the opened detail pane.
		expect(screen.getAllByText('$4,900.00').length).toBe(2);
		expect(screen.getAllByText('proposal').length).toBeGreaterThan(0);
		// Linked company/contact resolve to their names, not the raw ids the deal stores.
		expect(await screen.findByRole('button', { name: 'Acme Inc' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Ada Lovelace' })).toBeInTheDocument();
	});

	it('jumps to the linked company from a deal', async () => {
		mockApi({
			role: 'analyst',
			companyAnalytics: { linked: false, reason: 'no_linked_contacts' },
		});
		renderCrm();
		await openDeal();

		fireEvent.click(await screen.findByRole('button', { name: 'Acme Inc' }));
		await screen.findByRole('heading', { name: 'Analytics rollup' });
		expect(screen.getByRole('tab', { name: 'Companies', selected: true })).toBeInTheDocument();
	});

	it('hides delete from an analyst and offers it to an admin', async () => {
		mockApi({ role: 'analyst' });
		const { unmount } = renderCrm();
		await openDeal();
		expect(screen.queryByRole('button', { name: 'Delete deal' })).not.toBeInTheDocument();
		expect(screen.getByText(/needs the/i)).toHaveTextContent(/admin/i);
		unmount();

		mockApi({ role: 'admin' });
		renderCrm();
		await openDeal();
		fireEvent.click(await screen.findByRole('button', { name: 'Delete deal' }));
		expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be undone/i);
	});
});
