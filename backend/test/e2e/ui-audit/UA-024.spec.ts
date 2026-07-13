// UA-024: the corner timestamp shares its right edge with the panel and
// preview content columns. Red while it overhangs both by 2px (inset 14 vs
// padding 16 on the panel; 9 vs 11 on the preview).
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './harness';

test('UA-024: corner timestamps align with the content right edge', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture }),
		);
		await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await nudgeUntil(page, () => document.querySelectorAll('.ytb-note-dot').length >= 5);
		await page.click('.ytb-note-dot[data-ytb-note-id="n-own"]');
		await page.waitForSelector('#ytb-note-panel .ytb-panel-byline', { timeout: 15_000 });

		const { timeRight, bylineRight, previewDelta } = await page.evaluate(() => {
			const time = document.querySelector('#ytb-note-panel .ytb-panel-time')!.getBoundingClientRect();
			const byline = document.querySelector('#ytb-note-panel .ytb-panel-byline')!.getBoundingClientRect();
			const preview = document.querySelector('.ytb-note-dot[data-ytb-note-id="n-text"] .ytb-note-preview')!;
			const pt = getComputedStyle(preview.querySelector('.ytb-preview-time')!);
			const pp = getComputedStyle(preview);
			return {
				timeRight: time.right,
				bylineRight: byline.right,
				previewDelta: parseFloat(pp.paddingRight) - parseFloat(pt.right),
			};
		});
		expect.soft(Math.abs(timeRight - bylineRight), `panel time right ${timeRight} vs content ${bylineRight}`).toBeLessThanOrEqual(0.5);
		expect.soft(Math.abs(previewDelta), `preview time inset vs padding delta ${previewDelta}`).toBeLessThanOrEqual(0.5);
	} finally {
		await context.close();
	}
});
