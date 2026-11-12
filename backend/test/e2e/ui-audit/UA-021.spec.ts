// UA-021: the Room Home Connection Lost line uses secondary styling.
import { expect, test } from '@playwright/test';
import { homeFixture, launchExtension, nudgeUntil, openHomePanel, routeBackend, seedPaired } from './harness';

test('UA-021: the retrying line shares the muted secondary styling', async () => {
	const context = await launchExtension();
	try {
		const state = { down: false, read: () => ({}) };
		routeBackend(context, state);
		await seedPaired(context);
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		const home = await context.newPage();
		await home.goto('https://www.youtube.com/');
		await openHomePanel(home);
		await nudgeUntil(home, () => Boolean(document.querySelector('#ytb-home-section .ytb-hs-feed-scroll')));
		state.down = true;
		await home.evaluate(() => {
			(window as any).failedReads = 0;
			document.addEventListener('ytb:room-data', (event) => {
				if (!(event as CustomEvent).detail.ok) (window as any).failedReads++;
			});
		});
		for (let attempt = 1; attempt <= 2; attempt++) {
			await home.evaluate(() => document.dispatchEvent(new Event('yt-navigate-finish')));
			await expect.poll(() => home.evaluate(() => (window as any).failedReads)).toBeGreaterThanOrEqual(attempt);
		}
		await expect(home.locator('#ytb-home-section .ytb-hs-conn')).toBeVisible();
		const { size, color, muted } = await home.evaluate(() => {
			const el = document.querySelector('#ytb-home-section .ytb-hs-conn')!;
			const probe = document.createElement('span');
			probe.style.color = 'var(--ytb-ink-muted)';
			document.body.appendChild(probe);
			const muted = getComputedStyle(probe).color;
			probe.remove();
			const s = getComputedStyle(el);
			return { size: parseFloat(s.fontSize), color: s.color, muted };
		});
		expect.soft(size, `Room Home Connection Lost font-size ${size}`).toBe(11);
		expect.soft(color, 'Room Home Connection Lost muted color').toBe(muted);
	} finally {
		await context.close();
	}
});
