// UA-002: the Buddy Room pill's outline states (is-added / is-recommended)
// must meet AA against the page behind them - label >= 4.5:1, border >= 3:1 -
// in both themes. Red while both render hardcoded #f6a96b on the page (1.94:1).
import { expect, test } from '@playwright/test';
import { contrastRatio, launchExtension, makeData, nudgeUntil, playbackFixture, resolveColor, routeBackend, seedPaired } from './harness';

test('UA-002: pill outline states pass AA against the page in both themes', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture }),
		);
		const popup = await seedPaired(context);
		const page = await context.newPage();

		for (const theme of ['light', 'dark'] as const) {
			await popup.evaluate((t) => chrome.storage.local.set({ theme: t }), theme);
			// The fixture page stands in for YouTube, whose page background follows
			// the theme; stamp it so contrast is measured against the real ground.
			const pageBg = theme === 'dark' ? 'rgb(15, 15, 15)' : 'rgb(255, 255, 255)';
			for (const [videoId, state] of [
				['vid-inroom', 'is-added'],
				['vid-own', 'is-recommended'],
			] as const) {
				await page.goto(`https://www.youtube.com/watch?v=${videoId}`);
				await page.evaluate((bg) => (document.body.style.background = bg), pageBg);
				await nudgeUntil(page, () => {
					const b = document.getElementById('ytb-playlist-add-button');
					return Boolean(b && b.offsetParent !== null);
				});
				await expect(page.locator(`#ytb-playlist-add-button.${state}`)).toBeVisible();
				const { color, borderColor } = await page.evaluate(() => {
					const b = document.getElementById('ytb-playlist-add-button')!;
					const s = getComputedStyle(b);
					return { color: s.color, borderColor: s.borderTopColor };
				});
				const bg = [...(await resolveColor(page, pageBg))];
				const label = contrastRatio([...(await resolveColor(page, color))], bg);
				const border = contrastRatio([...(await resolveColor(page, borderColor))], bg);
				expect.soft(label, `${state} label in ${theme}: ${label.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
				expect.soft(border, `${state} border in ${theme}: ${border.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
			}
		}
	} finally {
		await context.close();
	}
});
