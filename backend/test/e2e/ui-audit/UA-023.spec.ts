// UA-023: elevation is tinted, never gray (DESIGN.md 1.1). Red while the
// light theme's switch knob casts a pure untinted black shadow.
import { expect, test } from '@playwright/test';
import { homeFixture, launchExtension, openHomePanel, routeBackend, seedPaired } from './harness';

test('UA-023: the switch knob shadow is warm-tinted in light theme', async () => {
	const context = await launchExtension();
	try {
		routeBackend(context, { down: false, read: () => ({}) });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		await seedPaired(context, { theme: 'light' });
		const home = await context.newPage();
		await home.goto('https://www.youtube.com/');
		await openHomePanel(home);
		await home.locator('.ytb-hs-icon').click();
		await home.waitForSelector('.ytb-hs-switch > span');
		const shadow = await home.evaluate(() => getComputedStyle(document.querySelector('.ytb-hs-switch > span')!).boxShadow);
		// Chromium serializes the color as rgb() or oklch() depending on gamut;
		// achromatic means r=g=b, or an oklch chroma of 0.
		const rgb = shadow.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
		const ok = shadow.match(/oklch\(\s*[\d.%]+\s+([\d.]+)\s/);
		expect(Boolean(rgb || ok), `parseable shadow color: ${shadow}`).toBe(true);
		const achromatic = rgb ? Number(rgb[1]) === Number(rgb[2]) && Number(rgb[2]) === Number(rgb[3]) : Number(ok![1]) === 0;
		expect(achromatic, `achromatic shadow ${shadow}`).toBe(false);
	} finally {
		await context.close();
	}
});
