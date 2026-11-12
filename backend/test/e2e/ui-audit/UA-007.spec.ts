// UA-007: the popup's sole action must offer a >= 24px-tall hit area.
import { expect, test } from '@playwright/test';
import { launchExtension, seedPaired } from './harness';

test('UA-007: popup action reaches the 24px hit minimum', async () => {
	const context = await launchExtension();
	try {
		const popup = await seedPaired(context);
		await popup.reload();
		const height = await popup.locator('#your-room').evaluate((button) => (button as HTMLElement).offsetHeight);
		expect(height, `#your-room height ${height}`).toBeGreaterThanOrEqual(24);
		expect(await popup.locator('a').count()).toBe(0);
	} finally {
		await context.close();
	}
});
