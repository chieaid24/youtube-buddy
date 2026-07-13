// UA-005: the recommendation card's Dismiss control must offer a >= 24x24
// hit area (DESIGN.md 1.3). Red while the button is 20x20.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, homeFixture, PIXEL_PNG, routeBackend, seedPaired } from './harness';

test('UA-005: every Dismiss control is at least 24x24', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG }));
		await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		await nudgeUntil(page, () => document.querySelectorAll('#ytb-home-section .ytb-hs-remove').length >= 2);
		const rects = await page.evaluate(() =>
			[...document.querySelectorAll('#ytb-home-section .ytb-hs-remove')].map((el) => {
				const r = el.getBoundingClientRect();
				return { w: r.width, h: r.height };
			}),
		);
		for (const [i, { w, h }] of rects.entries()) {
			expect.soft(w, `dismiss ${i} width`).toBeGreaterThanOrEqual(24);
			expect.soft(h, `dismiss ${i} height`).toBeGreaterThanOrEqual(24);
		}
	} finally {
		await context.close();
	}
});
