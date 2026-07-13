// UA-022: settings group eyebrows and the row labels beneath them share a
// left edge (within the popup's systematic 2px optical indent), as the
// roster achieves with its bleed pattern. Red at a 4px offset.
import { expect, test } from '@playwright/test';
import { launchExtension, seedPaired } from './harness';

test('UA-022: settings eyebrows and row labels align', async () => {
	const context = await launchExtension();
	try {
		const popup = await seedPaired(context);
		await popup.reload();
		await popup.click('#settings-open');
		await popup.waitForSelector('.set-row .set-row-text');
		const delta = await popup.evaluate(() => {
			const eyebrow = document.querySelector('.set-group .eyebrow')!.getBoundingClientRect();
			const label = document.querySelector('.set-row .set-row-text')!.getBoundingClientRect();
			return Math.abs(label.left - eyebrow.left);
		});
		expect(delta, `label-to-eyebrow left offset ${delta}px`).toBeLessThanOrEqual(2);
	} finally {
		await context.close();
	}
});
