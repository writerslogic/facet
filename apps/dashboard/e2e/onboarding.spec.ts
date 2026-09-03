import { expect, test } from '@playwright/test';

test('first-run onboarding validates credentials but never persists them', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: /Welcome to Facet/ })).toBeVisible();
	await page.getByRole('button', { name: 'View dashboard' }).click();
	await expect(page.getByRole('alert')).toHaveCount(2);

	await page.getByLabel('API key').fill(`clk_${'a'.repeat(64)}`);
	await page.getByLabel('Site ID').fill('77777777-7777-4777-8777-777777777777');
	await page.getByLabel(/label/i).fill('Browser test');
	await page.getByRole('button', { name: 'View dashboard' }).click();
	await expect(page.getByRole('tablist', { name: 'Analytics views' })).toBeVisible();
	const stored = await page.evaluate(() =>
		[localStorage, sessionStorage]
			.flatMap((storage) => Object.keys(storage).map((key) => storage.getItem(key)))
			.join('|'),
	);
	expect(stored).not.toContain('clk_');
	await page.reload();
	await expect(page.getByRole('button', { name: /Active site: Browser test/ })).toBeVisible();
});

test('onboarding remains usable at a narrow mobile viewport', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 740 });
	await page.goto('/');
	await expect(page.getByRole('heading', { name: /Welcome to Facet/ })).toBeVisible();
	await page.getByLabel('Email').fill('operator@example.com');
	await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'View dashboard' })).toBeInViewport();
});
