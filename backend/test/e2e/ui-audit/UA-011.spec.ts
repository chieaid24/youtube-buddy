// UA-011: UI copy is printable ASCII; user-authored content may contain emoji.
import { expect, test } from '@playwright/test';
import {
	launchExtension,
	makeData,
	nudgeUntil,
	openHomePanel,
	homeFixture,
	playbackFixture,
	PIXEL_PNG,
	routeBackend,
	seedPaired,
} from './harness';

const nonAscii = (text: string) => [...text].filter((c) => c.charCodeAt(0) > 0x7e);

test('UA-011: rendered UI copy is printable ASCII', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		const state = { down: false, read: () => d };
		routeBackend(context, state);
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'text/html',
				body: new URL(route.request().url()).pathname === '/watch' ? playbackFixture : homeFixture,
			}),
		);
		await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG }));
		const popup = await seedPaired(context);

		// Watch page: Buddy marker tooltips.
		const watch = await context.newPage();
		await watch.goto('https://www.youtube.com/watch?v=fixture-video');
		await nudgeUntil(watch, () => document.querySelectorAll('.ytb-watch-marker').length >= 2);
		const markerText = await watch.evaluate(() =>
			[...document.querySelectorAll('.ytb-watch-marker')].map((m) => m.textContent || '').join('\n'),
		);
		expect.soft(nonAscii(markerText), `marker tooltips: ${markerText}`).toEqual([]);

		// Home section, paired + Connection Lost states (the feed here carries no
		// user-authored emoji, so every non-ASCII hit is OUR copy).
		const home = await context.newPage();
		await home.goto('https://www.youtube.com/');
		await openHomePanel(home);
		await nudgeUntil(home, () => document.querySelectorAll('#ytb-home-section .ytb-hs-card').length >= 2);
		state.down = true;
		await home.evaluate(() => document.dispatchEvent(new Event('yt-navigate-finish')));
		await home.waitForTimeout(500);
		await home.evaluate(() => document.dispatchEvent(new Event('yt-navigate-finish')));
		await home.waitForSelector('#ytb-home-section .ytb-hs-conn', { timeout: 15_000 });
		const sectionText = await home.evaluate(() => document.getElementById('ytb-home-section')!.textContent || '');
		expect.soft(nonAscii(sectionText), `home section copy`).toEqual([]);
		// The Dismiss control is an icon, not a text glyph.
		expect.soft(await home.evaluate(() => document.querySelector('.ytb-hs-remove svg') !== null)).toBe(true);

		const popupCopy = await popup.locator('body').innerText();
		expect.soft(nonAscii(popupCopy), `popup copy: ${popupCopy}`).toEqual([]);
	} finally {
		await context.close();
	}
});
