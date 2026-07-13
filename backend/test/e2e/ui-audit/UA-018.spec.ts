// UA-018: on-video text sizes come from the declared 11/13/15/16 type scale
// (DESIGN.md 1.2). Red while previews, panel buttons, statuses, alert cards,
// and composer meta text render 12px. Emoji glyph sizes are pictographs, not
// type, and are not asserted.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './harness';

const SIZES = new Set([11, 13, 15, 16]);

const SELECTORS = [
	'.ytb-note-dot[data-ytb-note-id="n-text"] .ytb-note-preview',
	'#ytb-note-panel .ytb-panel-gohere',
	'#ytb-note-panel .ytb-panel-delete',
	'#ytb-note-panel .ytb-panel-error',
	'#ytb-note-panel .ytb-panel-reply-body',
	'#ytb-note-composer .ytb-note-time',
	'#ytb-note-composer label',
	'#ytb-note-composer .ytb-note-error',
];

test('UA-018: on-video type sits on the declared scale', async () => {
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
		const panelSizes = await page.evaluate(
			(sels) =>
				sels
					.map((sel) => ({ sel, el: document.querySelector(sel) }))
					.filter((x) => x.el)
					.map(({ sel, el }) => ({ sel, size: parseFloat(getComputedStyle(el!).fontSize) })),
			SELECTORS.slice(0, 5),
		);
		await page.keyboard.press('Escape');
		await page.waitForFunction(() => !document.getElementById('ytb-note-panel'));
		await page.click('#ytb-note-button');
		await page.waitForSelector('#ytb-note-composer label', { timeout: 10_000 });
		const composerSizes = await page.evaluate(
			(sels) =>
				sels
					.map((sel) => ({ sel, el: document.querySelector(sel) }))
					.filter((x) => x.el)
					.map(({ sel, el }) => ({ sel, size: parseFloat(getComputedStyle(el!).fontSize) })),
			SELECTORS.slice(5),
		);
		const all = [...panelSizes, ...composerSizes];
		expect(all.length).toBeGreaterThanOrEqual(7);
		for (const { sel, size } of all) {
			expect.soft(SIZES.has(size), `${sel} font-size ${size}px`).toBe(true);
		}
	} finally {
		await context.close();
	}
});
