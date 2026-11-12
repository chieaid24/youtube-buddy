// UA-022: settings headings and row labels share a left edge.
import { expect, test } from '@playwright/test';
import { homeFixture, launchExtension, openHomePanel, routeBackend, seedPaired } from './harness';

test('UA-022: settings eyebrows and row labels align', async () => {
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
		const delta = await home.evaluate(() => {
			const eyebrow = document.querySelector('.ytb-hs-set-group h3')!.getBoundingClientRect();
			const label = document.querySelector('.ytb-hs-switch-row > span')!.getBoundingClientRect();
			return Math.abs(label.left - eyebrow.left);
		});
		expect(delta, `label-to-eyebrow left offset ${delta}px`).toBeLessThanOrEqual(2);
	} finally {
		await context.close();
	}
});
