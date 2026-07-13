// UA-025: all three dot kinds open an Expanded Note on click, but only the
// reaction dot kept cursor: default while text and locked-Spoiler dots show
// pointer - the same semantic control must share its affordance.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './harness';

test('UA-025: the Reaction dot shows the pointer cursor like its siblings', async () => {
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
		const cursors = await page.evaluate(() => ({
			text: getComputedStyle(document.querySelector('.ytb-note-dot[data-ytb-note-id="n-text"]')!).cursor,
			reaction: getComputedStyle(document.querySelector('.ytb-note-dot[data-ytb-note-id="n-react"]')!).cursor,
			locked: getComputedStyle(document.querySelector('.ytb-note-dot[data-ytb-note-id="n-spoiler"]')!).cursor,
		}));
		expect(cursors.text).toBe('pointer');
		expect(cursors.locked).toBe('pointer');
		expect(cursors.reaction, 'reaction dot cursor').toBe('pointer');
	} finally {
		await context.close();
	}
});
