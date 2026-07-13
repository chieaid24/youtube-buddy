// UA-012: the Watched-By Dots cluster is focusable (tooltip on focus) and
// must offer a >= 24x24 target. Red at 16px tall (and 16px wide for a
// single-dot cluster).
import { expect, test } from '@playwright/test';
import { launchExtension, nudgeUntil, watchedByDotsFixture, routeBackend, seedPaired } from './harness';

test('UA-012: dot clusters reach 24x24 for one and two dots', async () => {
	const context = await launchExtension();
	try {
		const now = Date.now();
		routeBackend(context, {
			down: false,
			read: () => ({
				progress: [
					{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-classic', timestamp: 55, duration: 100, updatedAt: now - 330_000 },
					{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-two', timestamp: 10, duration: 100, updatedAt: now - 330_000 },
					{ clientId: 'buddy-2', name: 'Kim', videoId: 'vid-two', timestamp: 70, duration: 100, updatedAt: now - 150_000 },
				],
			}),
		});
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: watchedByDotsFixture }),
		);
		await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		await nudgeUntil(page, () => document.querySelectorAll('.ytb-thumb-dots').length >= 2);
		const rects = await page.evaluate(() =>
			[...document.querySelectorAll('.ytb-thumb-dots')].map((el) => {
				const r = el.getBoundingClientRect();
				return { w: r.width, h: r.height, dots: el.querySelectorAll('.ytb-thumb-dot').length };
			}),
		);
		for (const { w, h, dots } of rects) {
			expect.soft(w, `${dots}-dot cluster width ${w}`).toBeGreaterThanOrEqual(24);
			expect.soft(h, `${dots}-dot cluster height ${h}`).toBeGreaterThanOrEqual(24);
		}
	} finally {
		await context.close();
	}
});
