// UA-016: on-video card spacing sits on the declared 4/8/12/16/20/24 scale
// (DESIGN.md 1.3). Red while the notes/composer/mentions/pill stylesheets
// hardcode 14, 10, 9, 11, 7, 6, 3, 2px values.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './harness';

const SCALE = new Set([0, 4, 8, 12, 16, 20, 24]);

// selector -> properties that carry the surface's rhythm.
const CHECKS: [string, string[]][] = [
	['.ytb-note-dot[data-ytb-note-id="n-text"] .ytb-note-preview', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
	['#ytb-note-panel', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
	['#ytb-note-panel .ytb-panel-actions', ['margin-top', 'gap']],
	['#ytb-note-panel .ytb-panel-replies', ['margin-top']],
	['#ytb-note-panel .ytb-panel-reply', ['padding-top', 'padding-bottom']],
	['#ytb-note-panel .ytb-panel-reply-area', ['margin-top']],
	['#ytb-note-panel .ytb-panel-composer', ['gap']],
	['#ytb-note-composer', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
	['#ytb-note-composer .ytb-note-head', ['margin-bottom']],
	['#ytb-note-composer .ytb-note-emojis', ['gap', 'margin-bottom']],
	['#ytb-note-composer .ytb-note-foot', ['gap']],
	['#ytb-note-composer label', ['gap']],
	['#ytb-note-composer .ytb-note-meta', ['margin-top']],
	['#ytb-note-composer .ytb-note-error', ['margin-top']],
	['.ytb-mention-popover .ytb-mention-option', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
	['#ytb-playlist-add-button', ['padding-left', 'padding-right']],
];

test('UA-016: on-video spacing sits on the token scale', async () => {
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
		await page.click('.ytb-note-dot[data-ytb-note-id="n-own"]');
		await page.waitForSelector('#ytb-note-panel .ytb-panel-reply', { timeout: 15_000 });
		// The composer cannot open while a panel is up; measure the panel first,
		// then swap. The mention popover needs a trailing '@' in the composer.
		const measure = (pairs: [string, string[]][]) =>
			page.evaluate((list) => {
				const out: { selector: string; property: string; value: string }[] = [];
				for (const [selector, properties] of list) {
					const el = document.querySelector(selector);
					if (!el) continue;
					const s = getComputedStyle(el);
					for (const property of properties) out.push({ selector, property, value: s.getPropertyValue(property) });
				}
				return out;
			}, pairs);

		const panelRows = await measure(CHECKS.slice(0, 7));
		await page.keyboard.press('Escape');
		await page.waitForFunction(() => !document.getElementById('ytb-note-panel'));
		await page.click('#ytb-note-button');
		await page.waitForSelector('#ytb-note-composer textarea', { timeout: 10_000 });
		await page.fill('#ytb-note-composer textarea', 'hey @');
		await page.evaluate(() => {
			const ta = document.querySelector('#ytb-note-composer textarea') as HTMLTextAreaElement;
			ta.setSelectionRange(ta.value.length, ta.value.length);
			ta.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await page.waitForSelector('.ytb-mention-popover .ytb-mention-option', { timeout: 5_000 });
		const restRows = await measure(CHECKS.slice(7));

		for (const { selector, property, value } of [...panelRows, ...restRows]) {
			const px = Math.round(parseFloat(value));
			expect.soft(SCALE.has(px), `${selector} ${property}: ${value}`).toBe(true);
		}
		expect(panelRows.length + restRows.length).toBeGreaterThanOrEqual(30);
	} finally {
		await context.close();
	}
});
