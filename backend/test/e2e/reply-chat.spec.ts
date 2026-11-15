import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './ui-audit/harness';

test('conversation authors precede messages and posting labels use local times or dates', async () => {
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
		await seedPaired(context);
		const page = await context.newPage();
		await page.clock.setFixedTime(now);
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await nudgeUntil(page, () => document.querySelectorAll('.ytb-note-dot').length >= 5);
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
		await timestamp.hover();
		expect(await timestamp.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('underline');
		await timestamp.focus();
		await page.keyboard.press('Enter');
		await expect(panel).toHaveCount(0);
		expect(await page.locator('video').evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThanOrEqual(11);
	} finally {
		await context.close();
	}
});
