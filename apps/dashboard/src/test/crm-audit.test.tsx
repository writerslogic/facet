// The CRM access log. What has to be right here is not the table — it is the two sentences beside
// it, because both correct a reading the rows invite:
//   1. An entry is an AUTHORIZED ATTEMPT, not a success. Read as "succeeded", a run of probes against
//      ids that do not exist becomes a run of disclosures that never happened.
//   2. The log has a HORIZON. Without it, "no entries" reads as "nothing happened" when it may mean
//      "it happened more than a year ago".
// Plus: the 403 must name `admin`, since the contacts wording names `analyst` and a refusal that
// states the wrong requirement sends the reader to ask for a role that would not have helped.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Crm } from '../components/Crm.js';

const SITE = '11111111-1111-4111-8111-111111111111';
const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const CONTACT = {
	id: 'c1',
	site_id: SITE,
	external_user_id: null,
	email: 'ada@example.com',
	name: 'Ada Lovelace',
	phone: null,
	company: null,
	company_id: null,
	title: null,
	status: 'active',
	source: null,
	notes: null,
	owner_user_id: null,
	created_at: NOW,
	updated_at: NOW,
};

const ENTRIES = [
	{
		id: 'a1',
		site_id: SITE,
		actor_user_id: 'u-admin',
		actor_email: 'admin@example.com',
		actor_role: 'admin',
		action: 'contact.export',
		target_id: 'c1',
		occurred_at: NOW,
	},
	{
		id: 'a2',
		site_id: SITE,
		actor_user_id: 'u-gone',
		// The account has since been closed. The id remains, so the entry still names someone.
		actor_email: null,
		actor_role: 'analyst',
		action: 'contact.list',
		target_id: null,
		occurred_at: NOW - 1000,
	},
];

interface Handlers {
	status?: number;
	error?: string;
	retentionDays?: number;
}

/** Records every audit URL asked for, so the filter assertions test the REQUEST and not just the
 * rendering of a fixture that never changed. */
function mockApi(handlers: Handlers = {}): string[] {
	const auditUrls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : String(input);
			if (url.startsWith('/api/crm/audit')) {
				auditUrls.push(url);
				if (handlers.status) {
					return {
						ok: false,
						status: handlers.status,
						json: async () => ({ error: handlers.error }),
					};
				}
				const days = handlers.retentionDays ?? 365;
				return {
					ok: true,
					status: 200,
					json: async () => ({
						entries: ENTRIES,
						total: ENTRIES.length,
						role: 'admin',
						retention_days: days,
						covers_since: NOW - days * DAY,
					}),
				};
			}
			if (url.startsWith('/api/crm/contacts/')) {
				return { ok: true, status: 200, json: async () => ({ contact: CONTACT }) };
			}
			if (url.startsWith('/api/crm/companies')) {
				return { ok: true, status: 200, json: async () => ({ companies: [], total: 0 }) };
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ contacts: [CONTACT], total: 1, role: 'admin' }),
			};
		}),
	);
	return auditUrls;
}

function renderCrm() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<Crm siteId={SITE} />
		</QueryClientProvider>,
	);
}

async function openLog(): Promise<void> {
	fireEvent.click(await screen.findByRole('tab', { name: 'Access log' }));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the access log', () => {
	it('names who did what, in prose rather than in action codes', async () => {
		mockApi();
		renderCrm();
		await openLog();

		expect(await screen.findByText('admin@example.com')).toBeInTheDocument();
		// Scoped to the table: every action name is also an <option> in the filter, so an unscoped
		// query would pass on the filter alone and prove nothing about the rows.
		const rows = within(screen.getByRole('table'));
		expect(rows.getByText(/Exported a contact/)).toBeInTheDocument();
		expect(rows.getByText('Listed contacts')).toBeInTheDocument();
		// The role is the one the request was AUTHORIZED under, not the role held today.
		expect(screen.getByText(/as admin/)).toBeInTheDocument();
	});

	it('falls back to the id when the account behind an entry is gone', async () => {
		mockApi();
		renderCrm();
		await openLog();

		// Not a blank and not an invented name: the entry still says someone specific did this.
		expect(await screen.findByText('u-gone')).toBeInTheDocument();
		expect(screen.getByText(/account closed/)).toBeInTheDocument();
	});

	it('says an entry is an authorized attempt rather than a success', async () => {
		mockApi();
		renderCrm();
		await openLog();

		// The sentence is broken across elements by the emphasis on "authorized", so this matches the
		// contiguous half that carries the claim.
		expect(await screen.findByText(/not that it succeeded/i)).toBeInTheDocument();
		expect(screen.getByText(/probing, not someone being shown anything/i)).toBeInTheDocument();
	});

	it('states the horizon, so an empty page cannot read as "nothing happened"', async () => {
		mockApi({ retentionDays: 30 });
		renderCrm();
		await openLog();

		expect(await screen.findByText(/is retained/)).toBeInTheDocument();
		expect(screen.getByText(/30 days/)).toBeInTheDocument();
		expect(screen.getByText(/aged out/)).toBeInTheDocument();
	});

	it('names the admin role when refused, not the analyst role contacts needs', async () => {
		mockApi({ status: 403, error: 'forbidden' });
		renderCrm();
		await openLog();

		expect(await screen.findByText(/needs the admin role/i)).toBeInTheDocument();
		// The contacts wording, which would send the reader to ask for a role that changes nothing.
		expect(
			screen.queryByText(/Your role does not include CRM access/i),
		).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
	});

	it('explains an unbound deployment rather than erroring', async () => {
		mockApi({ status: 501, error: 'crm_unavailable' });
		renderCrm();
		await openLog();

		expect(
			await screen.findByText(/CRM extension is not enabled on this deployment/i),
		).toBeInTheDocument();
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});
});

describe('asking the log a question about one record', () => {
	it('opens filtered to a contact from that contact’s own pane', async () => {
		// The question a subject-access request or a suspected leak actually asks. A whole-site log
		// answers it only by being read end to end.
		const urls = mockApi();
		renderCrm();
		fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }));
		fireEvent.click(await screen.findByRole('button', { name: /Access log/ }));

		expect(await screen.findByText(/every recorded access to/i)).toBeInTheDocument();
		await waitFor(() => expect(urls.some((u) => u.includes('target_id=c1'))).toBe(true));
		// And it says what survives an erasure, because that is exactly when this is asked.
		expect(screen.getByText(/Entries survive the record they name/)).toBeInTheDocument();
	});

	it('filters by an operator when their name is clicked, and back again', async () => {
		const urls = mockApi();
		renderCrm();
		await openLog();

		fireEvent.click(await screen.findByRole('button', { name: 'admin@example.com' }));
		await waitFor(() =>
			expect(urls.some((u) => u.includes('actor_user_id=u-admin'))).toBe(true),
		);
		expect(screen.getByText(/one operator’s activity/i)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Show everyone' }));
		await waitFor(() =>
			expect(screen.queryByText(/one operator’s activity/i)).not.toBeInTheDocument(),
		);
	});

	it('filters by a target when the id is clicked', async () => {
		const urls = mockApi();
		renderCrm();
		await openLog();

		fireEvent.click(await screen.findByRole('button', { name: 'c1' }));
		await waitFor(() => expect(urls.some((u) => u.includes('target_id=c1'))).toBe(true));
	});

	it('filters by action without sending one when every action is wanted', async () => {
		const urls = mockApi();
		renderCrm();
		await openLog();
		await screen.findByText('admin@example.com');

		fireEvent.change(screen.getByLabelText('Action'), {
			target: { value: 'contact.delete' },
		});
		await waitFor(() =>
			expect(urls.some((u) => u.includes('action=contact.delete'))).toBe(true),
		);
		expect(urls[0]).not.toContain('action=');
	});
});
