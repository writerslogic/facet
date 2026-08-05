// Admin-token store: the ADMIN_TOKEN grants deployment-wide admin access, so it is kept OUT of the
// site-credential profile store and out of localStorage. It lives in memory + sessionStorage only,
// is never placed in a URL/log, and is only ever attached to /api/{sites,keys,goals,funnels,experiments,flags}
// via adminFetch. "Forget admin token" clears both memory and sessionStorage.

import {
	type ReactElement,
	type ReactNode,
	createContext,
	createElement,
	useCallback,
	useContext,
	useState,
} from 'react';

const ADMIN_TOKEN_STORAGE = 'facet.adminToken';

/** Endpoints the admin token may be sent to. Nothing else is permitted. */
const ADMIN_PATHS = [
	'/api/sites',
	'/api/keys',
	'/api/goals',
	'/api/funnels',
	'/api/experiments',
	'/api/flags',
	// Only `/api/users/:id/revoke-sessions` exists under this prefix and it is behind `requireAdmin`.
	// Listed because the allowlist is what stops the token reaching a route that never asked for it —
	// a genuine admin route missing from here fails closed with `non_admin_path`, which is the right
	// default and the reason this is an explicit line rather than a widened pattern.
	'/api/users',
];

function isAdminPath(path: string): boolean {
	const base = path.split('?')[0] ?? path;
	return ADMIN_PATHS.some((p) => base === p || base.startsWith(`${p}/`));
}

/** Read the admin token from sessionStorage (survives reload within a tab, cleared on tab close). */
function readAdminToken(): string {
	try {
		return sessionStorage.getItem(ADMIN_TOKEN_STORAGE) ?? '';
	} catch {
		return '';
	}
}

export interface AdminStore {
	token: string;
	hasToken: boolean;
	setToken: (token: string) => void;
	forgetToken: () => void;
}

const AdminContext = createContext<AdminStore | null>(null);

export function AdminProvider({
	children,
}: {
	children: ReactNode;
}): ReactElement {
	const [token, setTokenState] = useState<string>(readAdminToken);

	const setToken = useCallback((next: string) => {
		const trimmed = next.trim();
		try {
			if (trimmed) sessionStorage.setItem(ADMIN_TOKEN_STORAGE, trimmed);
			else sessionStorage.removeItem(ADMIN_TOKEN_STORAGE);
		} catch {
			// sessionStorage unavailable: keep it in memory only.
		}
		setTokenState(trimmed);
	}, []);

	const forgetToken = useCallback(() => {
		try {
			sessionStorage.removeItem(ADMIN_TOKEN_STORAGE);
		} catch {
			// ignore
		}
		setTokenState('');
	}, []);

	const store: AdminStore = {
		token,
		hasToken: token.length > 0,
		setToken,
		forgetToken,
	};

	return createElement(AdminContext.Provider, { value: store }, children);
}

export function useAdmin(): AdminStore {
	const store = useContext(AdminContext);
	if (!store) throw new Error('useAdmin must be used within AdminProvider');
	return store;
}

/** The server's 401 code from requireAdmin. Surfaced by adminFetch/adminPost/adminPatch as-is. */
export const INVALID_ADMIN_TOKEN = 'invalid_admin_token';

export function isAdminAuthError(error: unknown): boolean {
	return error instanceof Error && error.message === INVALID_ADMIN_TOKEN;
}

/**
 * Retry policy for admin queries. React Query's default retries three times with backoff, so one
 * wrong or rotated ADMIN_TOKEN meant every panel re-sent the rejected credential three more times
 * before saying anything — noisy against the server and several seconds of silence for the operator.
 * A rejected token will not become valid by asking again, so auth failures fail immediately.
 */
export function adminQueryRetry(failureCount: number, error: unknown): boolean {
	if (isAdminAuthError(error)) return false;
	return failureCount < 2;
}

/** GET/DELETE helper for admin endpoints only. Refuses non-admin paths so the token can't leak. */
export async function adminFetch<T>(
	path: string,
	token: string,
	init?: { method?: 'GET' | 'DELETE' },
): Promise<T> {
	if (!isAdminPath(path)) throw new Error('non_admin_path');
	const res = await fetch(path, {
		method: init?.method ?? 'GET',
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? 'request_failed');
	}
	return (await res.json()) as T;
}

/** POST helper for admin endpoints only. Refuses non-admin paths so the token can't leak. */
export async function adminPost<T>(path: string, token: string, body: unknown): Promise<T> {
	if (!isAdminPath(path)) throw new Error('non_admin_path');
	const res = await fetch(path, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const errorBody = (await res.json().catch(() => ({}))) as {
			error?: string;
		};
		throw new Error(errorBody.error ?? 'request_failed');
	}
	return (await res.json()) as T;
}

/** PATCH helper for admin endpoints only. Refuses non-admin paths so the token can't leak. */
export async function adminPatch<T>(path: string, token: string, body: unknown): Promise<T> {
	if (!isAdminPath(path)) throw new Error('non_admin_path');
	const res = await fetch(path, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const errorBody = (await res.json().catch(() => ({}))) as {
			error?: string;
		};
		throw new Error(errorBody.error ?? 'request_failed');
	}
	return (await res.json()) as T;
}
