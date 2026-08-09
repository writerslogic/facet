// the export control triggers an authed download whose request carries the active site + range
// (and preserves an optional hostname filter).

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportButton } from '../components/ExportButton.js';
import { exportPath } from '../lib/download.js';

beforeEach(() => {
	globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
	globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('exportPath', () => {
	it('carries site, range, kind, format, and optional filters', () => {
		const path = exportPath({
			siteId: 'site-1',
			range: { start: 100, end: 200 },
			kind: 'breakdown',
			format: 'csv',
			dimension: 'path',
			hostname: 'example.com',
		});
		expect(path).toContain('site_id=site-1');
		expect(path).toContain('start=100');
		expect(path).toContain('end=200');
		expect(path).toContain('kind=breakdown');
		expect(path).toContain('dimension=path');
		expect(path).toContain('hostname=example.com');
	});

	it('carries the active cross-filter segment, so an export matches a filtered board', () => {
		const path = exportPath({
			siteId: 'site-1',
			range: { start: 100, end: 200 },
			kind: 'series',
			format: 'csv',
			segment: { device: 'mobile', country: 'US' },
		});
		expect(path).toContain('device=mobile');
		expect(path).toContain('country=US');
	});
});

describe('ExportButton', () => {
	it('fetches an export carrying the active site + range with the bearer key', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			blob: async () => new Blob(['ts,pv\n'], { type: 'text/csv' }),
		});
		vi.stubGlobal('fetch', fetchMock);

		render(
			<ExportButton
				apiKey="clk_secret"
				siteId="site-42"
				range={{ start: 1000, end: 2000 }}
				interval="day"
			/>,
		);

		fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
		fireEvent.click(screen.getByRole('menuitem', { name: 'Time series' }));

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toContain('site_id=site-42');
		expect(String(url)).toContain('start=1000');
		expect(String(url)).toContain('end=2000');
		expect(String(url)).toContain('kind=series');
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: 'Bearer clk_secret',
		});
	});

	it('forwards the active segment prop into the export request', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			blob: async () => new Blob(['ts,pv\n'], { type: 'text/csv' }),
		});
		vi.stubGlobal('fetch', fetchMock);

		render(
			<ExportButton
				apiKey="clk_secret"
				siteId="site-42"
				range={{ start: 1000, end: 2000 }}
				interval="day"
				segment={{ device: 'mobile' }}
			/>,
		);

		fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
		fireEvent.click(screen.getByRole('menuitem', { name: 'Time series' }));

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const [url] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toContain('device=mobile');
	});
});
