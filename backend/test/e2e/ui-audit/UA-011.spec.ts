// UA-011: DESIGN.md section 5 bans non-ASCII in UI copy ("ASCII-only in
// source and copy. No em dashes in UI copy."). Red while the popup's
// Retrying line uses U+2026, the home section's Connection Lost line uses
// U+2014 + U+2026 and its Dismiss glyph U+00D7, and the watch marker tooltip
// uses U+00B7. Emoji in user-authored Note bodies are content, not copy.
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
		// state.down stays true: the popup needs two failed 5s polls of its own.
		const sectionText = await home.evaluate(() => document.getElementById('ytb-home-section')!.textContent || '');
		expect.soft(nonAscii(sectionText), `home section copy`).toEqual([]);
		// The Dismiss control is an icon, not a text glyph.
		expect.soft(await home.evaluate(() => document.querySelector('.ytb-hs-remove svg') !== null)).toBe(true);

		// Popup Connection Lost copy. Foreground the popup and reload so its
		// polling is not background-throttled: the open read plus the first 5s
		// poll supply the two consecutive failures.
		await popup.bringToFront();
		await popup.reload();
		await popup.waitForFunction(() => (document.getElementById('status-sub')?.textContent || '').includes('Retrying'), null, {
			timeout: 20_000,
		});
		const popupStatus = await popup.evaluate(
			() => (document.getElementById('status-text')?.textContent || '') + (document.getElementById('status-sub')?.textContent || ''),
		);
		expect.soft(nonAscii(popupStatus), `popup status copy: ${popupStatus}`).toEqual([]);
	} finally {
		await context.close();
	}
});
