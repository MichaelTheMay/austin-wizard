import { test, expect } from '@playwright/test';

test('app main page loads and can navigate to analytics', async ({ page }) => {
	await page.goto('http://localhost:5174');
	await expect(page.locator('h1')).toContainText('Austin/Travis ZIPs');
	await page.click('text=Analytics');
	await expect(page.locator('h2')).toContainText('Analytics');
});