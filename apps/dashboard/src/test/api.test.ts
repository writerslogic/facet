import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../api.js';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('apiFetch', () => {
	it('sends the bearer header and returns parsed data', async () => {
		const payload = { summary: { pageviews: 3 } };
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => payload,
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await apiFetch<typeof payload>('/api/stats?site_id=x', 'secret');

		expect(result).toEqual(payload);
		const call = fetchMock.mock.calls[0];
		expect(call).toBeDefined();
		expect(call?.[1].headers.Authorization).toBe('Bearer secret');
	});

	it('throws the error message from a 401 body', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			json: async () => ({ error: 'invalid_api_key' }),
		});
		vi.stubGlobal('fetch', fetchMock);

		await expect(apiFetch('/api/stats', 'bad')).rejects.toThrow('invalid_api_key');
	});
});
