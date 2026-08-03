// UA-009: the unpaired prompt's Create / input / Join row renders three
// different control heights (27 / 31.6 / 29) and puts its input and
// secondary borders on --ytb-line where DESIGN.md's role set names
// line-strong for input borders, with the input well on surface-sunk.
import { expect, test } from '@playwright/test';
import { launchExtension, nudgeUntil, openHomePanel, homeFixture, routeBackend, seedPaired } from './harness';

test('UA-009: unpaired row controls share a height and the documented tokens', async () => {
	const context = await launchExtension();
	try {
		routeBackend(context, { down: false, read: () => ({}) });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		const popup = await seedPaired(context);
		await popup.evaluate(() => chrome.storage.local.remove(['code']));
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		await openHomePanel(page);
		await nudgeUntil(page, () => document.querySelectorAll('#ytb-home-section .ytb-hs-pair-actions > *').length >= 3);

		const m = await page.evaluate(() => {
			const resolve = (token: string) => {
				const probe = document.createElement('div');
				probe.style.color = `var(${token})`;
				document.getElementById('ytb-home-section')!.appendChild(probe);
				const value = getComputedStyle(probe).color;
				probe.remove();
				return value;
			};
			const heights = [...document.querySelectorAll<HTMLElement>('#ytb-home-section .ytb-hs-pair-actions > *')].map(
				(el) => el.offsetHeight,
			);
			const input = document.querySelector('#ytb-home-section .ytb-hs-input')!;
			const secondary = document.querySelector('#ytb-home-section .ytb-hs-btn:not(.ytb-hs-btn-primary)')!;
			return {
				heights,
				inputBorder: getComputedStyle(input).borderTopColor,
				inputBackground: getComputedStyle(input).backgroundColor,
				secondaryBorder: getComputedStyle(secondary).borderTopColor,
				lineStrong: resolve('--ytb-line-strong'),
				surfaceSunk: resolve('--ytb-surface-sunk'),
			};
		});
		expect.soft(Math.max(...m.heights) - Math.min(...m.heights), `heights ${m.heights.join(', ')}`).toBeLessThanOrEqual(1);
		expect.soft(m.inputBorder, 'input border on line-strong').toBe(m.lineStrong);
		expect.soft(m.secondaryBorder, 'secondary border on line-strong').toBe(m.lineStrong);
		expect.soft(m.inputBackground, 'input well on surface-sunk').toBe(m.surfaceSunk);
	} finally {
		await context.close();
	}
});
