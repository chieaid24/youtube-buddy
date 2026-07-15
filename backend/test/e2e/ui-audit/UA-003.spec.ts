// UA-003: real meta text (timestamps, "Posted ...", reply times, the Delete
// label, the composer's character counter) must meet AA (>= 4.5:1) on its
// card surface in both themes. Red while these use --ytb-ink-faint, the
// placeholder/disabled tier (3.3:1 light / 3.9:1 dark); ink-muted is the
// design's meta text role and passes. Placeholders and disabled states stay
// on ink-faint by design and are not asserted here.
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
} from './harness';

test('UA-003: contrast measurement waits for the resting transition color', async ({ page }) => {
	await page.setContent(`
		<style>
			#transitioning-meta {
				background: rgb(255, 255, 255);
				color: rgb(255, 255, 255);
				transition: color 500ms linear;
			}
			.settled-theme #transitioning-meta { color: rgb(32, 32, 32); }
		</style>
		<div id="transitioning-meta">Meta</div>
	`);
	const activeTransitions = await page.evaluate(() => {
		const meta = document.getElementById('transitioning-meta')!;
		void getComputedStyle(meta).color;
		document.documentElement.classList.add('settled-theme');
		return meta.getAnimations().length;
	});
	expect(activeTransitions).toBe(1);

	const { fg, bg } = await textAndBackground(page, '#transitioning-meta');
	expect(fg).toEqual([32, 32, 32, 255]);
	expect(bg).toEqual([255, 255, 255, 255]);
});

test('UA-003: meta text passes AA on the panel, preview, and composer in both themes', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture }),
		);
		const popup = await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await nudgeUntil(page, () => document.querySelectorAll('.ytb-note-dot').length >= 5);

		// The viewer's own text Note carries every meta role at once: corner
		// timestamp, Posted line, reply times, and the Delete trigger.
		await page.click('.ytb-note-dot[data-ytb-note-id="n-own"]');
		await page.waitForSelector('#ytb-note-panel .ytb-panel-reply-time', { timeout: 15_000 });

		const panelSelectors = [
			'#ytb-note-panel .ytb-panel-time',
			'#ytb-note-panel .ytb-panel-posted',
			'#ytb-note-panel .ytb-panel-reply-time',
			'#ytb-note-panel .ytb-panel-delete',
			'.ytb-note-dot[data-ytb-note-id="n-text"] .ytb-preview-time',
		];

		for (const theme of ['light', 'dark'] as const) {
			await popup.evaluate((t) => chrome.storage.local.set({ theme: t }), theme);
			await expect.poll(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme)).toBe(true);
			for (const selector of panelSelectors) {
				const { fg, bg } = await textAndBackground(page, selector);
				const ratio = contrastRatio(fg, bg);
				expect.soft(ratio, `${selector} in ${theme}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
			}
		}

		// The composer's live counter.
		await page.keyboard.press('Escape');
		await page.waitForFunction(() => !document.getElementById('ytb-note-panel'));
		await page.click('#ytb-note-button');
		await page.waitForSelector('#ytb-note-composer .ytb-note-meta', { timeout: 10_000 });
		for (const theme of ['light', 'dark'] as const) {
			await popup.evaluate((t) => chrome.storage.local.set({ theme: t }), theme);
			await expect.poll(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme)).toBe(true);
			const { fg, bg } = await textAndBackground(page, '#ytb-note-composer .ytb-note-meta');
			const ratio = contrastRatio(fg, bg);
			expect.soft(ratio, `.ytb-note-meta in ${theme}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
		}
	} finally {
		await context.close();
	}
});
