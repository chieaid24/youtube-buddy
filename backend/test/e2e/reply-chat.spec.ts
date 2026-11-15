import { expect, test } from '@playwright/test';
import {
	contrastRatio,
	launchExtension,
	makeData,
	nudgeUntil,
	playbackFixture,
	routeBackend,
	seedPaired,
	textAndBackground,
} from './ui-audit/harness';

test('conversation separates video navigation from authors and posting times', async ({}, testInfo) => {
	const context = await launchExtension();
	try {
		const now = new Date(2026, 10, 15, 17, 34).getTime();
		const data = makeData(now);
		data.notes.find((note) => note.id === 'n-own')!.createdAt = now;
		data.replies[0].createdAt = new Date(2026, 10, 14, 17, 34).getTime();
		data.replies[1].createdAt = now;
		routeBackend(context, { down: false, read: () => data });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture }),
		);
		const popup = await seedPaired(context);
		const page = await context.newPage();
		await page.clock.setFixedTime(now);
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await nudgeUntil(page, () => document.querySelectorAll('.ytb-note-dot').length >= 5);
		await page.addStyleTag({ content: '.html5-video-player a:hover, .html5-video-player a:focus { color: white; }' });
		await page.locator('.ytb-note-dot[data-ytb-note-id="n-own"]').click();
		const panel = page.locator('#ytb-note-panel');
		await expect(panel.locator('.ytb-panel-posted')).toHaveText('5:34 PM');
		await expect(panel.locator('.ytb-panel-reply-time')).toHaveText(['Nov 14, 2026', '5:34 PM']);
		const rows = await panel.evaluate((element) => {
			return [
				['.ytb-panel-author', '.ytb-panel-body'],
				['.ytb-panel-reply-author', '.ytb-panel-reply-body'],
			].map(([author, body]) => ({
				authorBottom: element.querySelector(author)!.getBoundingClientRect().bottom,
				bodyTop: element.querySelector(body)!.getBoundingClientRect().top,
			}));
		});
		for (const row of rows) expect(row.authorBottom).toBeLessThanOrEqual(row.bodyTop);
		await expect(panel.getByRole('button', { name: 'Go here' })).toHaveCount(0);
		const timestamp = panel.getByRole('link', { name: 'Go to timestamp 0:12' });
		await expect(timestamp).toHaveAttribute('title', 'Go to timestamp');
		expect(await timestamp.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('none');
		await expect(panel.locator('.ytb-panel-header')).toContainText('Video timestamp');
		const layout = await panel.evaluate((el) => ({
			headerBottom: el.querySelector('.ytb-panel-header')!.getBoundingClientRect().bottom,
			bylineTop: el.querySelector('.ytb-panel-byline')!.getBoundingClientRect().top,
			composerBottom: el.querySelector('.ytb-panel-reply-area')!.getBoundingClientRect().bottom,
			deleteTop: el.querySelector('.ytb-panel-delete')!.getBoundingClientRect().top,
		}));
		expect(layout.headerBottom).toBeLessThan(layout.bylineTop);
		expect(layout.composerBottom).toBeLessThan(layout.deleteTop);
		const remove = panel.getByRole('button', { name: 'Delete note', exact: true });
		await remove.click();
		const cancel = panel.getByRole('button', { name: 'Cancel', exact: true });
		await expect(cancel).toBeFocused();
		await expect(panel.locator('.ytb-panel-actions .ytb-panel-confirm')).toBeVisible();
		await cancel.click();
		await expect(remove).toBeFocused();
		await expect(panel.locator('.ytb-panel-confirm')).toBeHidden();
		for (const theme of ['light', 'dark'] as const) {
			await popup.evaluate((value) => chrome.storage.local.set({ theme: value }), theme);
			await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
			await timestamp.hover();
			expect(await timestamp.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('underline');
			for (const state of ['hover', 'focus'] as const) {
				if (state === 'focus') await timestamp.focus();
				const { fg, bg } = await textAndBackground(page, '#ytb-note-panel .ytb-panel-time');
				expect(contrastRatio(fg, bg), `${theme} ${state}`).toBeGreaterThanOrEqual(4.5);
			}
			await panel.screenshot({ path: testInfo.outputPath(`conversation-${theme}.png`) });
		}
		await timestamp.focus();
		await page.keyboard.press('Enter');
		await expect(panel).toHaveCount(0);
		expect(await page.locator('video').evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThanOrEqual(11);
	} finally {
		await context.close();
	}
});
