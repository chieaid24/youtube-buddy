// UA-020: the Notification Position cells follow the shared radius and ring.
import { expect, test } from '@playwright/test';
import { homeFixture, launchExtension, openHomePanel, routeBackend, seedPaired } from './harness';

test('UA-020: edge-picker cells use the scale radius and shared ring', async () => {
	const context = await launchExtension();
	try {
		routeBackend(context, { down: false, read: () => ({}) });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		await seedPaired(context);
		const home = await context.newPage();
		await home.goto('https://www.youtube.com/');
		await openHomePanel(home);
		await home.locator('.ytb-hs-icon').click();
		await home.locator('.ytb-hs-edges').scrollIntoViewIfNeeded();
		await home.locator('.ytb-hs-switch-row').last().focus();
		await home.keyboard.press('Tab');
		const { radius, shadow } = await home.evaluate(() => {
			const cell = document.activeElement as HTMLElement;
			if (!cell.matches('.ytb-hs-edges button')) throw new Error('never reached an edge cell by Tab');
			const s = getComputedStyle(cell);
			return { radius: parseFloat(s.borderTopLeftRadius), shadow: s.boxShadow };
		});
		expect.soft([8, 12, 16, 999].includes(radius), `edge-cell radius ${radius}px`).toBe(true);
		expect.soft(shadow, `edge-cell ring ${shadow}`).toContain('0px 0px 0px 3px');
	} finally {
		await context.close();
	}
});
