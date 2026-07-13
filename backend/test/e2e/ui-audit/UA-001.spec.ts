// UA-001: Buddy Colors used as text ink on opaque card surfaces must meet
// WCAG AA (>= 4.5:1) for EVERY palette color in BOTH themes. Red while the
// raw fill colors are used directly (7 of 8 fail on light, 4 on dark).
import { expect, test } from '@playwright/test';
import {
	contrastRatio,
	launchExtension,
	makeData,
	nudgeUntil,
	playbackFixture,
	homeFixture,
	PIXEL_PNG,
	routeBackend,
	seedPaired,
	textAndBackground,
	VIEWER,
} from './harness';

const PALETTE = ['#00a6d6', '#f0a500', '#7655d6', '#00a86b', '#e85d04', '#d936c7', '#558b2f', '#4776e6'];

/** Sweep every palette color through buddy-1 and measure the selector's contrast. */
async function sweep(popup: import('@playwright/test').Page, page: import('@playwright/test').Page, selector: string, label: string) {
	for (const theme of ['light', 'dark'] as const) {
		await popup.evaluate((t) => chrome.storage.local.set({ theme: t }), theme);
		await expect.poll(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme)).toBe(true);
		for (const color of PALETTE) {
			const previous = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)!).color, selector);
			await popup.evaluate(
				([c]) => chrome.storage.local.set({ buddyColors: { 'silly-otters': { 'buddy-1': c, 'buddy-2': '#7655d6' } } }),
				[color],
			);
			// Wait for the live repaint to land (skip when the color cannot change,
			// e.g. the transform of the new color equals the previous computed value).
			await page
				.waitForFunction(([sel, prev]) => getComputedStyle(document.querySelector(sel)!).color !== prev, [selector, previous] as const, {
					timeout: 1500,
				})
				.catch(() => {});
			const { fg, bg } = await textAndBackground(page, selector);
			const ratio = contrastRatio(fg, bg);
			expect
				.soft(ratio, `${label} ${selector} with ${color} in ${theme}: ${ratio.toFixed(2)}:1 (fg ${fg.join(',')} on bg ${bg.join(',')})`)
				.toBeGreaterThanOrEqual(4.5);
		}
	}
}

test('UA-001a: Expanded Note authors pass AA for every Buddy Color in both themes', async () => {
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
		await page.click('.ytb-note-dot[data-ytb-note-id="n-own"]');
		await page.waitForSelector('#ytb-note-panel .ytb-panel-reply-author', { timeout: 15_000 });
		// The reply byline written by Sam (buddy-1) is the measured element.
		await sweep(popup, page, '#ytb-note-panel .ytb-panel-reply:first-child .ytb-panel-reply-author', 'panel');
	} finally {
		await context.close();
	}
});

test('UA-001b: Room Feed authors pass AA for every Buddy Color in both themes', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG }));
		const popup = await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		await nudgeUntil(page, () => document.querySelectorAll('#ytb-home-section .ytb-hs-author').length >= 1);
		// Sam's "replied to your note" row (buddy-1).
		await sweep(popup, page, '#ytb-home-section .ytb-hs-author', 'feed');
	} finally {
		await context.close();
	}
});

// Guard: over-video identity text (reaction bursts, dots) and swatches keep the
// RAW Buddy Color - the text-safe blend applies only to card surfaces. The dot
// itself must stay exactly the assigned fill.
test('UA-001c: timeline dots keep the raw Buddy Color', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture }),
		);
		await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await nudgeUntil(page, () => document.querySelectorAll('.ytb-note-dot').length >= 5);
		const dotColor = await page.evaluate(
			() => getComputedStyle(document.querySelector('.ytb-note-dot[data-ytb-note-id="n-text"]')!).backgroundColor,
		);
		expect(dotColor).toBe('rgb(0, 166, 214)'); // buddy-1 seeded #00a6d6
	} finally {
		await context.close();
	}
});

void VIEWER;
