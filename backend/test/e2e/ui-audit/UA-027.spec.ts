import { expect, test } from '@playwright/test';
import { homeFixture, launchExtension, makeData, openHomePanel, routeBackend, seedPaired } from './harness';

test('UA-027: Settings controls meet target, type, swatch, and focus rules', async () => {
	const context = await launchExtension();
	try {
		await routeBackend(context, { down: false, read: () => makeData(Date.now()) });
		await context.route('https://www.youtube.com/**', (route) => route.fulfill({ contentType: 'text/html', body: homeFixture }));
		const popup = await seedPaired(context);
		const page = await context.newPage();
		await page.setViewportSize({ width: 800, height: 600 });
		await page.goto('https://www.youtube.com/');
		await openHomePanel(page);
		const panel = page.getByRole('dialog', { name: 'YouTube Buddy Room', exact: true });
		await panel.getByRole('button', { name: 'Settings', exact: true }).click();
		await expect(panel.getByRole('switch', { name: 'Spoiler Default' })).toBeVisible();
		await panel.getByRole('button', { name: 'Change color for Sam' }).click();

		const targets = await panel.locator('button').evaluateAll((elements) =>
			elements.map((el) => {
				const rect = el.getBoundingClientRect();
				return { name: el.getAttribute('aria-label') || el.textContent, width: rect.width, height: rect.height };
			}),
		);
		for (const target of targets) {
			expect.soft(target.width, `${target.name} width`).toBeGreaterThanOrEqual(24);
			expect.soft(target.height, `${target.name} height`).toBeGreaterThanOrEqual(24);
		}
		const swatches = panel.getByRole('group', { name: 'Buddy Color Swatches' }).getByRole('button');
		for (const swatch of [panel.getByRole('button', { name: 'Change color for Sam' }), swatches.first()]) {
			expect.soft(await swatch.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('2px');
		}
		for (const control of [panel.getByRole('switch', { name: 'Show Notes' }), panel.getByRole('radio', { name: 'Light', exact: true })]) {
			const style = await control.evaluate((el) => {
				const s = getComputedStyle(el);
				return { family: s.fontFamily, size: s.fontSize, weight: s.fontWeight };
			});
			expect.soft(style.family).toContain('YTB Rounded');
			expect.soft(style.size).toBe('13px');
			expect.soft(style.weight).toBe('600');
		}
		await page.keyboard.press('Tab');
		for (const theme of ['light', 'dark']) {
			await popup.evaluate((value) => chrome.storage.local.set({ theme: value }), theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			for (const control of [
				panel.locator('.ytb-hs-copy'),
				panel.getByRole('button', { name: 'Change color for Sam' }),
				swatches.nth(2),
				panel.getByRole('radio', { name: 'Light', exact: true }),
			]) {
				await control.focus();
				expect.soft(await control.evaluate((el) => getComputedStyle(el).boxShadow), `${theme} focus ring`).toContain('0px 0px 0px 3px');
			}
		}
	} finally {
		await context.close();
	}
});
