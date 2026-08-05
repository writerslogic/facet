// Session revocation, both halves: the operator ending their own sessions and a deployment admin
// ending someone else's. Until these panels existed both routes shipped and worked with no way to
// reach them, which for a security control is the same as not having one.
//
// What has to be right here is mostly not the markup:
//
//   • `/api/auth/logout-everywhere` answers 204 WITH NO BODY. Parsed as JSON that throws, and the
//     failure lands on the one operation where a false negative is worst: the sessions really are
//     gone, and a panel reporting an error would send someone to hunt for a revocation that already
//     happened. This is why `sessionSend` is separate from `sessionFetch`.
//   • The admin token may only travel to allowlisted paths. `/api/users` had to be added to that
//     list, and a missing entry fails closed as `non_admin_path` — silently, since the request never
//     leaves the browser. So the test asserts the request actually went out.
//   • A pasted user id is free text and lands in a URL PATH. Unencoded, a `/` in it re-points the
//     request past the prefix the allowlist checks.
//   • The server's 404 is deliberate: a mistyped id must not read as a revocation that never
//     happened. `Error: not_found` preserves that distinction and hides it.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperatorSessionsPanel } from '../components/settings/OperatorSessionsPanel.js';
import { SessionPanel } from '../components/settings/SessionPanel.js';

const ADMIN_TOKEN = 'admintoken-secret';
const USER = { id: 'u-ada', email: 'ada@example.com', name: 'Ada Lovelace' };

interface Call {
	url: string;
	method: string;
	auth: string | null;
}

/** A 204 as fetch really presents one: ok, no content, and a body that is not JSON because there is
 * no body at all. Mocking it as `json: async () => ({})` would test nothing — that is precisely the
 * shape the old code assumed and the reason it would have passed while broken. */
function noContent() {
	return {
		ok: true,
		status: 204,
		json: async () => {
			throw new SyntaxError('Unexpected end of JSON input');
		},
	};
}

interface Options {
	/** Status for `GET /api/auth/me`. 200 unless set. */
	meStatus?: number;
	meError?: string;
	/** Status for the revoke/logout POSTs. */
	postStatus?: number;
	postError?: string;
}

function mockApi(opts: Options = {}): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : String(input);
			const headers = new Headers(init?.headers ?? {});
			calls.push({
				url,
				method: init?.method ?? 'GET',
				auth: headers.get('Authorization'),
			});

			if (url.startsWith('/api/auth/me')) {
				if (opts.meStatus) {
					return {
						ok: false,
						status: opts.meStatus,
						json: async () => ({ error: opts.meError }),
					};
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({ user: USER, memberships: [] }),
				};
			}

			if (opts.postStatus) {
				return {
					ok: false,
					status: opts.postStatus,
					json: async () => ({ error: opts.postError }),
				};
			}
			if (url.startsWith('/api/auth/logout-everywhere')) return noContent();
			return {
				ok: true,
				status: 200,
				json: async () => ({ user_id: 'u-ada', sessions_revoked: true }),
			};
		}),
	);
	return calls;
}

function renderPanel(node: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/**
 * Match a sentence that spans child elements.
 *
 * `getByText` compares against an element's DIRECT text nodes only, so emphasising one word splits
 * the sentence and hides it. That matters here rather than being a testing detail: the word inside
 * the `<strong>` is "not", and an assertion that silently skipped it would pass just as happily on
 * text claiming revocation IS a lockout.
 */
function textAcross(pattern: RegExp) {
	return (_: string, el: Element | null): boolean =>
		el?.tagName === 'P' && pattern.test(el.textContent ?? '');
}

/** Arm and confirm a two-step button whose trigger and confirm share a label. Arming REPLACES the
 * trigger, so the same query resolves to the confirm on the second call rather than ambiguously. */
async function confirmTwoStep(name: string): Promise<void> {
	fireEvent.click(await screen.findByRole('button', { name }));
	fireEvent.click(await screen.findByRole('button', { name }));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the operator’s own session', () => {
	it('reports success when the server answers 204 with no body', async () => {
		const calls = mockApi();
		renderPanel(<SessionPanel />);
		await screen.findByText('Ada Lovelace');

		await confirmTwoStep('Sign out everywhere');

		expect(await screen.findByText('Signed out everywhere')).toBeInTheDocument();
		expect(
			calls.some((c) => c.url === '/api/auth/logout-everywhere' && c.method === 'POST'),
		).toBe(true);
		// The failure this guards against is a rejected mutation, which surfaces as this line.
		expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
	});

	it('says the session in this browser ended too, so the tab is known to be stale', async () => {
		mockApi();
		renderPanel(<SessionPanel />);
		await screen.findByText('Ada Lovelace');

		await confirmTwoStep('Sign out everywhere');

		expect(await screen.findByText(/including this one/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
	});

	it('states that a normal sign-out does not withdraw a token already copied out', async () => {
		mockApi();
		renderPanel(<SessionPanel />);

		expect(await screen.findByText(/rest of its thirty days/i)).toBeInTheDocument();
		// The absent per-device list is a deliberate consequence of storing no sessions, not an
		// omission — unexplained it reads as a missing feature.
		expect(screen.getByText(/no per-device list/i)).toBeInTheDocument();
	});

	it('arms before acting, and states the consequence rather than only the verb', async () => {
		const calls = mockApi();
		renderPanel(<SessionPanel />);
		await screen.findByText('Ada Lovelace');

		fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));

		expect(screen.getByRole('alert')).toHaveTextContent(/Ends every session on this account/i);
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('falls back to the email when the account carries a blank name', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					user: { id: 'u-ada', email: 'ada@example.com', name: '   ' },
					memberships: [],
				}),
			})),
		);
		renderPanel(<SessionPanel />);

		// Not a blank line above the address: a whitespace name is unset, as it is everywhere else.
		expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
		expect(screen.getAllByText('ada@example.com')).toHaveLength(1);
	});

	it('renders nothing at all when there is no session to end', async () => {
		mockApi({ meStatus: 401, meError: 'unauthenticated' });
		const { container } = renderPanel(<SessionPanel />);

		await waitFor(() => expect(container).toBeEmptyDOMElement());
	});

	it('renders nothing, rather than throwing, when a 200 is not the expected shape', async () => {
		// A proxy page, an SSO login form, a later server: parses fine, is not this shape.
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		}));
		vi.stubGlobal('fetch', fetchMock);

		// The SIBLING is the assertion, not an empty container. A throw during render unmounts the
		// whole tree, which empties the container too — so "renders nothing" and "took everything
		// down with it" are indistinguishable unless something that must survive is standing next to
		// it. In Settings that sibling is the entire admin area.
		renderPanel(
			<div>
				<SessionPanel />
				<p>the rest of settings</p>
			</div>,
		);

		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		// Let the response land and React commit the render it causes; the throw, if any, is there.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(screen.getByText('the rest of settings')).toBeInTheDocument();
		expect(screen.queryByText('Your account')).not.toBeInTheDocument();
	});

	it('renders nothing on a deployment that has no accounts', async () => {
		mockApi({ meStatus: 503, meError: 'auth_unavailable' });
		const { container } = renderPanel(<SessionPanel />);

		await waitFor(() => expect(container).toBeEmptyDOMElement());
		// A permanent "you cannot use this" panel on the majority deployment shape is noise.
		expect(screen.queryByText(/Your account/)).not.toBeInTheDocument();
	});
});

describe('ending another operator’s sessions', () => {
	it('sends the admin token to /api/users, which the path allowlist must permit', async () => {
		const calls = mockApi();
		renderPanel(<OperatorSessionsPanel token={ADMIN_TOKEN} />);

		fireEvent.change(screen.getByLabelText('Operator user id'), {
			target: { value: 'u-ada' },
		});
		await confirmTwoStep('Revoke sessions');

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			// A path missing from the allowlist throws before fetch, so the absence of this call IS
			// the failure — there is no error response to look for.
			expect(post?.url).toBe('/api/users/u-ada/revoke-sessions');
			expect(post?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
		});
		expect(await screen.findByText(/Every session for u-ada has ended/)).toBeInTheDocument();
	});

	it('encodes a pasted id so it cannot re-point the request at another route', async () => {
		const calls = mockApi();
		renderPanel(<OperatorSessionsPanel token={ADMIN_TOKEN} />);

		fireEvent.change(screen.getByLabelText('Operator user id'), {
			target: { value: '../keys?site_id=x' },
		});
		await confirmTwoStep('Revoke sessions');

		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST');
			expect(post).toBeDefined();
			expect(post?.url.startsWith('/api/users/')).toBe(true);
			expect(post?.url).not.toContain('/keys');
			expect(post?.url).toContain('%2F');
		});
	});

	it('explains a 404 instead of reporting the raw code', async () => {
		mockApi({ postStatus: 404, postError: 'not_found' });
		renderPanel(<OperatorSessionsPanel token={ADMIN_TOKEN} />);

		fireEvent.change(screen.getByLabelText('Operator user id'), {
			target: { value: 'u-typo' },
		});
		await confirmTwoStep('Revoke sessions');

		expect(
			await screen.findByText(/no operator on this deployment has that id/i),
		).toBeInTheDocument();
		expect(screen.getByText(/nothing was revoked/i)).toBeInTheDocument();
	});

	it('clears a stale outcome when the id it described is edited away', async () => {
		mockApi();
		renderPanel(<OperatorSessionsPanel token={ADMIN_TOKEN} />);
		const field = screen.getByLabelText('Operator user id');

		fireEvent.change(field, { target: { value: 'u-ada' } });
		await confirmTwoStep('Revoke sessions');
		expect(await screen.findByText(/Every session for u-ada has ended/)).toBeInTheDocument();

		fireEvent.change(field, { target: { value: 'u-someone-else' } });

		await waitFor(() =>
			expect(screen.queryByText(/Every session for u-ada has ended/)).not.toBeInTheDocument(),
		);
	});

	it('will not act on an empty id, and says why the button is missing', () => {
		mockApi();
		renderPanel(<OperatorSessionsPanel token={ADMIN_TOKEN} />);

		expect(screen.queryByRole('button', { name: 'Revoke sessions' })).not.toBeInTheDocument();
		expect(screen.getByText(/Enter an operator id/i)).toBeInTheDocument();
	});

	it('states that revoking is not a lockout', () => {
		mockApi();
		renderPanel(<OperatorSessionsPanel token={ADMIN_TOKEN} />);

		// An admin who reads this as "removes their access" will reach for it in the wrong situation
		// and avoid it in the right one.
		expect(screen.getByText(textAcross(/is not a lockout/i))).toBeInTheDocument();
		expect(screen.getByText(/sign in again with a new magic link/i)).toBeInTheDocument();
	});
});
