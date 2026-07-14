// UA-007: the popup's text links (#join-back, #chooser-cancel) are interactive
// and must offer a >= 24px-tall hit area (DESIGN.md 1.3). Red at ~19.6px.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, routeBackend, seedPaired } from './harness';

test('UA-007: popup text links reach the 24px hit minimum', async () => {
	const context = await launchExtension();
	try {
		// Stub the Room reads the popup makes on open, as every other spec here
		// does. Unstubbed, they never settle in headless Chromium (its local-network
		// gate has no prompt to answer), so the popup never leaves the chooser and
		// the Room actions this test drives are never reachable.
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
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
