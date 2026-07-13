// UA-023: elevation is tinted, never gray (DESIGN.md 1.1). Red while the
// light theme's switch knob casts a pure untinted black shadow.
import { expect, test } from '@playwright/test';
import { launchExtension, seedPaired } from './harness';

test('UA-023: the switch knob shadow is warm-tinted in light theme', async () => {
	const context = await launchExtension();
	try {
		const popup = await seedPaired(context, { theme: 'light' });
		await popup.reload();
		await popup.click('#settings-open');
		await popup.waitForSelector('.switch-knob');
		const shadow = await popup.evaluate(() => getComputedStyle(document.querySelector('.switch-knob')!).boxShadow);
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
