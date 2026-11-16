import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { homeFixture, launchExtension, makeData, openHomePanel, routeBackend, seedPaired } from './ui-audit/harness';

const output = process.env.YTB_SIDEBAR_SHOTS;

for (const theme of ['light', 'dark']) {
	for (const viewport of [
		{ width: 1280, height: 900 },
		{ width: 800, height: 600 },
	]) {
		test(`Settings sidebar ${theme} ${viewport.width}`, async () => {
			const context = await launchExtension();
			try {
				await routeBackend(context, { down: false, read: () => makeData(1800000000000) });
				await context.route('https://www.youtube.com/**', (route) => route.fulfill({ contentType: 'text/html', body: homeFixture }));
				const popup = await seedPaired(context, { theme });
				const page = await context.newPage();
				await page.setViewportSize(viewport);
				await page.emulateMedia({ reducedMotion: 'reduce' });
				await page.goto('https://www.youtube.com/');
				await page.addStyleTag({
					content:
						'body { min-height: 3000px; } *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }',
				});
				await page.evaluate(() => window.scrollTo(0, 200));
				await openHomePanel(page);
				const panel = page.locator('#ytb-home-section');
				await panel.getByRole('button', { name: 'Settings', exact: true }).click();
				await expect(panel.getByRole('switch', { name: 'Spoiler Default' })).toBeVisible();
				await page.evaluate(() => document.fonts.ready);
				const capture = async (name: string) => {
					if (!output) return;
					await page.waitForTimeout(200);
					await fs.mkdir(output, { recursive: true });
					const first = await panel.screenshot({ animations: 'disabled' });
					const second = await panel.screenshot({ animations: 'disabled' });
					expect(first.equals(second), `${name} capture is stable`).toBe(true);
					await fs.writeFile(path.join(output, `${theme}-${viewport.width}-${name}.png`), first);
				};
				await capture('settings-top');
				await panel.getByRole('button', { name: 'Change color for Sam' }).click();
				await capture('buddy-colors');
				await panel.getByRole('button', { name: 'Change color for Sam' }).click();
				await panel.getByRole('button', { name: 'Leave Room', exact: true }).click();
				await capture('leave-confirm');
				await page.keyboard.press('Escape');
				await panel.getByRole('switch', { name: 'Share video progress' }).click();
				await capture('sharing-confirm');
				await page.keyboard.press('Escape');
				await panel.getByRole('radiogroup', { name: 'Theme Preference' }).scrollIntoViewIfNeeded();
				await capture('settings-bottom');
				const measurements = await panel.locator('button, [role="radio"]').evaluateAll((els) =>
					els.map((el) => {
						const r = el.getBoundingClientRect();
						return {
							name: el.getAttribute('aria-label') || el.textContent,
							width: r.width,
							height: r.height,
							radius: getComputedStyle(el).borderRadius,
						};
					}),
				);
				if (output)
					await fs.writeFile(path.join(output, `${theme}-${viewport.width}-measurements.json`), JSON.stringify(measurements, null, 2));
				await expect(panel.getByRole('switch', { name: 'Spoiler Default' })).toHaveAttribute('aria-checked', 'false');
				for (const size of measurements) {
					expect(size.width, size.name || '').toBeGreaterThanOrEqual(24);
					expect(size.height, size.name || '').toBeGreaterThanOrEqual(24);
				}
				const before = await page.evaluate(() => window.scrollY);
				await page.mouse.move(10, 550);
				await page.mouse.wheel(0, 600);
				await page.waitForTimeout(150);
				expect(await page.evaluate(() => window.scrollY)).toBe(before);
				const scroll = panel.locator('.ytb-hs-settings');
				await scroll.evaluate((el) => {
					el.scrollTop = 0;
				});
				// The view fits the tall viewport; only the short one scrolls.
				if (await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)) {
					await scroll.hover();
					await page.mouse.wheel(0, 400);
					await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
				}
				await panel.getByRole('button', { name: 'Copy Room Code' }).click();
				await expect(panel.getByRole('status')).toHaveText('Copied!');
				// The chip sits centered over the button, inside the card, between the Room state text and the button.
				const chip = await page.evaluate(() => {
					const copy = document.querySelector('.ytb-hs-copy')!;
					const feedback = document.querySelector('.ytb-hs-copy-feedback')!.getBoundingClientRect();
					const button = copy.getBoundingClientRect();
					// Lowest ink the Room state text can reach: its baseline plus a descender ("Waiting").
					const status = document.querySelector('.ytb-hs-room-status strong')!;
					const text = document.createRange();
					text.selectNodeContents(status);
					const font = getComputedStyle(status);
					const pen = document.createElement('canvas').getContext('2d')!;
					pen.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
					const glyph = pen.measureText('g');
					const inkBottom = text.getBoundingClientRect().bottom - glyph.fontBoundingBoxDescent + glyph.actualBoundingBoxDescent;
					return {
						offCenter: Math.abs((feedback.left + feedback.right) / 2 - (button.left + button.right) / 2),
						pastCard: feedback.right - copy.closest('.ytb-hs-set-group')!.getBoundingClientRect().right,
						overButton: feedback.bottom - button.top,
						overStatus: inkBottom - feedback.top,
					};
				});
				expect(chip.offCenter).toBeLessThanOrEqual(0.5);
				expect(chip.pastCard).toBeLessThanOrEqual(0.5);
				expect(chip.overButton).toBeLessThanOrEqual(0);
				expect(chip.overStatus).toBeLessThanOrEqual(0);
				await capture('copied-code');
				await panel.getByRole('button', { name: 'Close', exact: true }).click();
				await page.mouse.move(10, 550);
				await page.mouse.wheel(0, 500);
				await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
				await popup.evaluate(() => chrome.storage.local.remove('code'));
				await page.reload();
				await openHomePanel(page);
				await page.addStyleTag({
					content: '* { transition: none !important; animation: none !important; caret-color: transparent !important; }',
				});
				await expect(panel.getByRole('button', { name: 'Create a room' })).toBeVisible();
				await page.evaluate(() => document.fonts.ready);
				await capture('unpaired');
				await routeBackend(context, { down: false, read: () => ({}) });
				await panel.getByRole('textbox', { name: 'Room Code to join' }).fill('missing-room');
				await panel.getByRole('button', { name: 'Join', exact: true }).click();
				await expect(panel.getByRole('status')).toHaveText("This room doesn't exist yet");
				await capture('join-error');
				await routeBackend(context, {
					down: false,
					read: () => ({
						progress: Array.from({ length: 5 }, (_, i) => ({
							clientId: `full-${i}`,
							name: `Buddy ${i}`,
							videoId: 'fixture-video',
							timestamp: i,
							duration: 20,
							updatedAt: 1800000000000,
						})),
					}),
				});
				await popup.evaluate(() => chrome.storage.local.set({ code: 'full-room' }));
				await page.reload();
				await openHomePanel(page);
				await page.addStyleTag({
					content: '* { transition: none !important; animation: none !important; caret-color: transparent !important; }',
				});
				await expect(panel.locator('.ytb-hs-room-status strong')).toHaveText('Room full');
				await page.evaluate(() => document.fonts.ready);
				await capture('room-full');
			} finally {
				await context.close();
			}
		});
	}
}

test('On-video rows keep their order, toggle only from the pill, and explain Spoiler Default', async () => {
	const context = await launchExtension();
	try {
		await routeBackend(context, { down: false, read: () => makeData(Date.now()) });
		await context.route('https://www.youtube.com/**', (route) => route.fulfill({ contentType: 'text/html', body: homeFixture }));
		await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		await openHomePanel(page);
		const panel = page.locator('#ytb-home-section');
		await panel.getByRole('button', { name: 'Settings', exact: true }).click();
		const group = panel.locator('.ytb-hs-set-group', { hasText: 'On-video' });
		await expect(group.locator('.ytb-hs-row > span:first-child')).toHaveText([
			'Show Buddy progress',
			'Share video progress',
			'Show Notes',
			'Spoiler Default',
			'Popup position',
		]);
		await expect(group.getByRole('radiogroup', { name: 'Popup position' })).toBeVisible();

		// The label is plain text: only the pill toggles.
		const notes = group.getByRole('switch', { name: 'Show Notes' });
		await expect(notes).toHaveAttribute('aria-checked', 'true');
		await group.getByText('Show Notes', { exact: true }).click();
		await expect(notes).toHaveAttribute('aria-checked', 'true');
		await notes.click();
		await expect(notes).toHaveAttribute('aria-checked', 'false');

		const hint = /Buddies can't read a Spoiler until they pass that moment/;
		await expect(group.locator('.ytb-hs-info')).toHaveCount(1);
		await expect(group.locator('.ytb-hs-info')).toHaveAttribute('title', hint);
		await expect(group.getByRole('switch', { name: 'Spoiler Default' })).toHaveAccessibleDescription(hint);
	} finally {
		await context.close();
	}
});

test('Room Home blocks background scrolling until every close path releases it', async () => {
	const context = await launchExtension();
	try {
		await routeBackend(context, { down: false, read: () => makeData(Date.now()) });
		await context.route('https://www.youtube.com/**', (route) => route.fulfill({ contentType: 'text/html', body: homeFixture }));
		await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		await page.addStyleTag({ content: 'html { overflow-y: scroll; } body { min-height: 4000px; }' });
		await page.evaluate(() => window.scrollTo(0, 200));
		for (const close of ['button', 'escape', 'scrim', 'navigation']) {
			await openHomePanel(page);
			const start = await page.evaluate(() => window.scrollY);
			await page.mouse.move(10, 550);
			await page.mouse.wheel(0, 500);
			await page.waitForTimeout(200);
			expect(await page.evaluate(() => window.scrollY), close).toBe(start);
			if (close === 'button') await page.getByRole('button', { name: 'Close', exact: true }).click();
			if (close === 'escape') await page.keyboard.press('Escape');
			if (close === 'scrim') await page.mouse.click(10, 550);
			if (close === 'navigation')
				await page.evaluate(() => {
					history.pushState({}, '', '/?review=1');
					document.dispatchEvent(new Event('yt-navigate-finish'));
				});
			await expect(page.locator('#ytb-home-overlay')).toHaveCount(0);
			await page.mouse.move(10, 550);
			await page.mouse.wheel(0, 300);
			await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(start);
		}
		await expect(page.locator('html')).toHaveCSS('overflow-y', 'scroll');
	} finally {
		await context.close();
	}
});
