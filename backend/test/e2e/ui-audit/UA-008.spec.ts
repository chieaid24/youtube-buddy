// UA-008: the Expanded Note must open with its reply list bottom-pinned so
// the newest reply is fully visible (matching renderReplies' documented
// intent and the post-reply behavior). Red while the seed render runs
// detached and the panel opens at scrollTop 0 with the last reply clipped.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './harness';

test('UA-008: the Expanded Note opens bottom-pinned with the newest reply fully visible', async () => {
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

		const state = await page.evaluate(() => {
			const wrap = document.querySelector('#ytb-note-panel .ytb-panel-replies') as HTMLElement;
			const rows = wrap.querySelectorAll<HTMLElement>('.ytb-panel-reply');
			const last = rows[rows.length - 1];
			// Rects share any ancestor transform (the open animation), so the
			// containment comparison stays valid mid-flight.
			return {
				overflows: wrap.scrollHeight > wrap.clientHeight,
				scrollTop: wrap.scrollTop,
				scrollHeight: wrap.scrollHeight,
				clientHeight: wrap.clientHeight,
				lastBottom: last.getBoundingClientRect().bottom,
				wrapBottom: wrap.getBoundingClientRect().bottom,
			};
		});
		// The fixture panel window is small enough that two replies overflow it;
		// if this ever stops overflowing the probe is vacuous, so assert it.
		expect(state.overflows, `replies overflow (${state.scrollHeight} > ${state.clientHeight})`).toBe(true);
		// Bottom-pinned within a pixel...
		expect(state.scrollTop, `scrollTop ${state.scrollTop} of ${state.scrollHeight - state.clientHeight}`).toBeGreaterThanOrEqual(
			state.scrollHeight - state.clientHeight - 1,
		);
		// ...and the newest reply's box fully inside the visible window.
		expect(state.lastBottom, `last reply bottom ${state.lastBottom} vs wrap ${state.wrapBottom}`).toBeLessThanOrEqual(
			state.wrapBottom + 0.5,
		);
	} finally {
		await context.close();
	}
});
