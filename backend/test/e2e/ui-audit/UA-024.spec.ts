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
			const preview = document.querySelector<HTMLElement>('.ytb-note-dot[data-ytb-note-id="n-text"] .ytb-note-preview')!;
			// The preview's timestamp is a grid item now (#158) - it reserves real
			// width instead of floating over the body - so its alignment is read off
			// the rendered edges, not off a CSS `right` inset it no longer carries.
			// Unhovered, the card rests at scale(.6), so its rendered inset is the
			// declared padding times that scale: divide it out and the check reads
			// the same at rest as it does under the pointer.
			const pt = preview.querySelector('.ytb-preview-time')!.getBoundingClientRect();
			const pp = preview.getBoundingClientRect();
			const cs = getComputedStyle(preview);
			const scale = pp.width / preview.offsetWidth;
			const inset = (parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth)) * scale;
			return {
				timeRight: time.right,
				bylineRight: byline.right,
				previewDelta: pp.right - inset - pt.right,
			};
		});
		expect.soft(Math.abs(timeRight - bylineRight), `panel time right ${timeRight} vs content ${bylineRight}`).toBeLessThanOrEqual(0.5);
		expect.soft(Math.abs(previewDelta), `preview time right vs content right delta ${previewDelta}`).toBeLessThanOrEqual(0.5);
	} finally {
		await context.close();
	}
});
