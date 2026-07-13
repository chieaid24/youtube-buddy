// UA-007: the popup's text links (#join-back, #chooser-cancel) are interactive
// and must offer a >= 24px-tall hit area (DESIGN.md 1.3). Red at ~19.6px.
import { expect, test } from '@playwright/test';
import { launchExtension, seedPaired } from './harness';

test('UA-007: popup text links reach the 24px hit minimum', async () => {
	const context = await launchExtension();
	try {
		const popup = await seedPaired(context);
		await popup.reload();
		await popup.click('#settings-open');
		await popup.click('#leave-room');
		await popup.click('#confirm-disconnect'); // leave the room -> chooser with Cancel? no code left, so no cancel
		await popup.waitForSelector('#choose-join', { state: 'visible' });
		await popup.click('#choose-join');
		await popup.waitForSelector('#join-back', { state: 'visible' });
		const height = await popup.evaluate(() => (document.getElementById('join-back') as HTMLElement).offsetHeight);
		expect(height, `#join-back height ${height}`).toBeGreaterThanOrEqual(24);
	} finally {
		await context.close();
	}
});
