// UA-006: the composer's Spoiler checkbox label is a click target and must be
// at least 24px tall (DESIGN.md 1.3). Red while the label region is 19px.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './harness';

test('UA-006: the Spoiler label offers a >= 24px-tall hit area', async () => {
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
		await nudgeUntil(page, () => Boolean(document.getElementById('ytb-note-button')));
		await page.click('#ytb-note-button');
		await page.waitForSelector('#ytb-note-composer label', { timeout: 10_000 });
		// offsetHeight: the layout box, unaffected by the composer's scale-in
		// spring (getBoundingClientRect mid-animation reads 24 * 0.98).
		const height = await page.evaluate(() => (document.querySelector('#ytb-note-composer label') as HTMLElement).offsetHeight);
		expect(height, `spoiler label height ${height}`).toBeGreaterThanOrEqual(24);
	} finally {
		await context.close();
	}
});
