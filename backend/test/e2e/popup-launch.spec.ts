import { expect, test } from '@playwright/test';
import { homeFixture, launchExtension, openHomePanel, seedPaired } from './ui-audit/harness';

test('the popup switches tabs and closes before YouTube finishes loading', async () => {
	const context = await launchExtension();
	let release = () => {};
	const loaded = new Promise<void>((resolve) => (release = resolve));
	try {
		await context.route('https://www.youtube.com/**', async (route) => {
			await loaded;
			await route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture });
		});
		const popup = await seedPaired(context);
		await popup.evaluate(() => {
			window.close = () => {
				(window as any).dismissed = true;
			};
		});
		const source = await context.newPage();
		await source.bringToFront();
		const before = new Set(context.pages());
		const feedback = await popup.evaluate(() => {
			document.getElementById('your-room')!.click();
			return {
				label: document.getElementById('your-room')!.textContent,
				busy: document.getElementById('your-room')!.getAttribute('aria-busy'),
			};
		});
		expect(feedback).toEqual({ label: 'Opening your room...', busy: 'true' });
		await expect.poll(() => popup.evaluate(() => (window as any).dismissed), { timeout: 2_000 }).toBe(true);
		const active = await popup.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
		expect(active.pendingUrl || active.url).toBe('https://www.youtube.com/#ytb-room');
		expect(source.url()).toBe('about:blank');
		await expect.poll(() => context.pages().filter((page) => !before.has(page)).length).toBe(1);
		const launched = context.pages().find((page) => !before.has(page))!;
		release();
		await expect(launched.locator('#ytb-home-section')).toBeVisible();
		await expect(launched).toHaveURL('https://www.youtube.com/');
		await launched.reload();
		await expect(launched.locator('#ytb-home-section')).toHaveCount(0);
	} finally {
		release();
		await context.close();
	}
});

for (const alreadyOpen of [false, true]) {
	test(`a stale YouTube Home tab recovers quickly with Room ${alreadyOpen ? 'open' : 'closed'}`, async () => {
		const context = await launchExtension();
		try {
			await context.route('https://www.youtube.com/**', (route) =>
				route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
			);
			const popup = await seedPaired(context);
			const popupUrl = popup.url();
			const home = await context.newPage();
			await home.goto('https://www.youtube.com/');
			await openHomePanel(home);
			if (!alreadyOpen) await home.locator('.ytb-hs-close').click();
			const extensions = await context.newPage();
			await extensions.goto('chrome://extensions/');
			await extensions.evaluate(() => (chrome as any).developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
			const extensionId = await extensions.locator('extensions-item').filter({ hasText: 'YouTube Buddy' }).getAttribute('id');
			await extensions.evaluate(
				(id) =>
					new Promise<void>((resolve, reject) => {
						(chrome as any).developerPrivate.reload(id, { failQuietly: true }, () => {
							if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
							else resolve();
						});
					}),
				extensionId,
			);
			const freshPopup = await context.newPage();
			await freshPopup.goto(popupUrl);
			await freshPopup.evaluate(() => {
				window.close = () => {
					(window as any).dismissed = true;
				};
			});
			await home.bringToFront();
			const before = new Set(context.pages());
			await freshPopup.evaluate(() => {
				document.getElementById('your-room')!.click();
			});
			await expect.poll(() => freshPopup.evaluate(() => (window as any).dismissed), { timeout: 2_000 }).toBe(true);
			await expect.poll(() => context.pages().filter((page) => !before.has(page)).length).toBe(1);
			const launched = context.pages().find((page) => !before.has(page))!;
			await expect(launched.locator('#ytb-home-section')).toBeVisible();
			await expect(launched).toHaveURL('https://www.youtube.com/');
			expect(home.url()).toBe('https://www.youtube.com/');
		} finally {
			await context.close();
		}
	});
}
