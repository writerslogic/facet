// Realtime snapshot hook: polls the trailing-window active-visitor proxy. Auto-refresh pauses while
// the page is hidden (via useVisible) so a backgrounded tab stops hammering the endpoint.

import type { RealtimeSnapshot } from '@facet/shared';
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { apiFetch } from '../api.js';

const REFETCH_MS = 15_000;

/** Subscribe to page visibility. Returns true when the document is visible (or unknowable). */
export function useVisible(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			document.addEventListener('visibilitychange', onChange);
			return () => document.removeEventListener('visibilitychange', onChange);
		},
		() => document.visibilityState !== 'hidden',
		() => true,
	);
}

export function useRealtime(apiKey: string, siteId: string) {
	const visible = useVisible();
	return useQuery({
		queryKey: ['realtime', siteId],
		queryFn: () => apiFetch<RealtimeSnapshot>(`/api/stats/realtime?site_id=${siteId}`, apiKey),
		enabled: Boolean(apiKey && siteId) && visible,
		refetchInterval: visible ? REFETCH_MS : false,
	});
}
