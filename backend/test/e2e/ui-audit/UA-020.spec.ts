// UA-020: the Notification Position picker's cells follow the popup's radius
// scale and share the 3px focus ring every sibling control uses. Red at
// radius 4px / ring 2px.
import { expect, test } from '@playwright/test';
import { launchExtension, seedPaired } from './harness';

test('UA-020: edge-picker cells use the scale radius and shared ring', async () => {
	const context = await launchExtension();
	try {
		const popup = await seedPaired(context);
		await popup.reload();
		await popup.click('#settings-open');
		await popup.waitForFunction(() => document.getElementById('edge-picker')!.children.length > 0);
		// Reach a cell with real Tab presses so :focus-visible matches (a
		// programmatic focus after the mouse click above would not).
		for (let i = 0; i < 20; i++) {
			await popup.keyboard.press('Tab');
			if (await popup.evaluate(() => document.activeElement?.classList.contains('edge-cell'))) break;
		}
		const { radius, shadow } = await popup.evaluate(() => {
			const cell = document.activeElement as HTMLElement;
			if (!cell.classList.contains('edge-cell')) throw new Error('never reached an edge-cell by Tab');
			const s = getComputedStyle(cell);
			return { radius: parseFloat(s.borderTopLeftRadius), shadow: s.boxShadow };
		});
		expect.soft([8, 12, 16, 999].includes(radius), `edge-cell radius ${radius}px`).toBe(true);
		expect.soft(shadow, `edge-cell ring ${shadow}`).toContain('0px 0px 0px 3px');
	} finally {
		await context.close();
	}
});
