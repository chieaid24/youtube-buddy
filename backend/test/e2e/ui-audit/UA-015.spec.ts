// UA-015: the guide toggle's ON-state icon color is the row's only visual
// ON/OFF signal, so it needs >= 3:1 against the guide background in both
// YouTube themes. Red while the light guide renders #f6a96b on white (1.94:1).
import { expect, test } from '@playwright/test';
import { contrastRatio, launchExtension, nudgeUntil, homeFixture, resolveColor, routeBackend, seedPaired } from './harness';

test('UA-015: the ON icon reads at 3:1 on light and dark guides', async () => {
	const context = await launchExtension();
	try {
		routeBackend(context, { down: false, read: () => ({}) });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		await nudgeUntil(page, () => {
			const t = document.getElementById('ytb-home-toggle');
			return Boolean(t && t.getAttribute('aria-checked') === 'true');
		});

		const measure = async (bg: string) => {
			const color = await page.evaluate(() => getComputedStyle(document.querySelector('#ytb-home-toggle .ytb-ht-icon')!).color);
			return contrastRatio([...(await resolveColor(page, color))], [...(await resolveColor(page, bg))]);
		};

		// Light guide (fixture background is white, like YouTube's light guide).
		const light = await measure('rgb(255, 255, 255)');
		expect.soft(light, `light guide ON icon ${light.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);

		// Dark guide: stamp YouTube's dark marker; the row keys off html[dark].
		await page.evaluate(() => document.documentElement.setAttribute('dark', ''));
		const dark = await measure('rgb(15, 15, 15)');
		expect.soft(dark, `dark guide ON icon ${dark.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
	} finally {
		await context.close();
	}
});
