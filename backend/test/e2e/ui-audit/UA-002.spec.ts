// UA-002: Recommend strip text must meet AA (>= 4.5:1) against the Note
// Composer surface in every state, in both themes.
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

const STATES: [videoId: string, strip: string, texts: string[]][] = [
	['fixture-video2', '.ytb-recommend-strip:not(.is-added):not(.is-recommended)', ['#ytb-playlist-add-button']],
	['vid-inroom', '.ytb-recommend-strip.is-added', ['.ytb-recommend-status']],
	['vid-own', '.ytb-recommend-strip.is-recommended', ['.ytb-recommend-status', '#ytb-playlist-add-button']],
];

test('UA-002: Recommend strip text passes AA on the composer in both themes', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture }),
		);
		const popup = await seedPaired(context);
		const page = await context.newPage();

		for (const theme of ['light', 'dark'] as const) {
			await popup.evaluate((t) => chrome.storage.local.set({ theme: t }), theme);
			for (const [videoId, strip, texts] of STATES) {
				await page.goto(`https://www.youtube.com/watch?v=${videoId}`);
				await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
				await nudgeUntil(page, () => Boolean(document.getElementById('ytb-note-button')));
				await page.click('#ytb-note-button');
				await expect(page.locator(strip)).toBeVisible();
				for (const text of texts) {
					const { fg, bg } = await textAndBackground(page, `${strip} ${text}`);
					const ratio = contrastRatio(fg, bg);
					expect.soft(ratio, `${videoId} ${text} in ${theme}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	} finally {
		await context.close();
	}
});
