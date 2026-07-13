// UA-010: the pill is a YTB-branded surface and must consume the --ytb-*
// tokens like its siblings: the design face (YTB Rounded), theme-aware accent
// colors, the r-pill radius, a constant label inset across its three states,
// and the shared --ytb-e-pop shadow on its feedback line. Red while the
// stylesheet hardcodes the palette, radius 18px, an unregistered 'Nunito'
// family, and an undefined --ytb-shadow-float token.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './harness';

test('UA-010: pill consumes the design tokens', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture }),
		);
		const popup = await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video2');
		await nudgeUntil(page, () => {
			const b = document.getElementById('ytb-playlist-add-button');
			return Boolean(b && b.offsetParent !== null);
		});
		const pill = () =>
			page.evaluate(() => {
				const b = document.getElementById('ytb-playlist-add-button')!;
				const s = getComputedStyle(b);
				return {
					fontFamily: s.fontFamily,
					faceLoaded: document.fonts.check(`500 14px 'YTB Rounded'`),
					background: s.backgroundColor,
					radius: s.borderRadius,
					inset: parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth),
				};
			});

		// The design face, not a dead 'Nunito' reference falling back to Arial.
		const idle = await pill();
		expect(idle.fontFamily.split(',')[0].replace(/["']/g, '').trim()).toBe('YTB Rounded');
		expect(idle.faceLoaded).toBe(true);
		// The r-pill radius, not 18px.
		expect(idle.radius).toBe('999px');

		// Theme-aware: the idle fill flips with the Theme Preference.
		await popup.evaluate(() => chrome.storage.local.set({ theme: 'dark' }));
		await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
		const dark = await pill();
		expect(dark.background).not.toBe(idle.background);
		await popup.evaluate(() => chrome.storage.local.set({ theme: 'light' }));

		// Constant label inset across the three states (no 1px shift on toggle).
		const insets: number[] = [idle.inset];
		for (const videoId of ['vid-inroom', 'vid-own']) {
			await page.goto(`https://www.youtube.com/watch?v=${videoId}`);
			await nudgeUntil(page, () => {
				const b = document.getElementById('ytb-playlist-add-button');
				return Boolean(b && b.offsetParent !== null);
			});
			insets.push((await pill()).inset);
		}
		expect(new Set(insets.map((v) => v.toFixed(2))).size, `label insets ${insets.join(', ')}`).toBe(1);

		// The feedback line uses the shared --ytb-e-pop elevation, not an
		// undefined token's literal fallback. Force a network-failed un-recommend
		// (vid-own is the viewer's) to surface it.
		await routeBackend(context, { down: false, read: () => d }); // re-register AFTER the write-abort route below
		await context.route('http://localhost:8787/playlist**', (route) =>
			route.request().method() === 'DELETE' ? route.abort('connectionrefused') : route.fallback(),
		);
		await page.click('#ytb-playlist-add-button');
		await page.waitForSelector('#ytb-playlist-feedback', { timeout: 10_000 });
		const { shadow, expected } = await page.evaluate(() => {
			const f = document.getElementById('ytb-playlist-feedback')!;
			const probe = document.createElement('div');
			probe.style.boxShadow = 'var(--ytb-e-pop)';
			document.body.appendChild(probe);
			const expected = getComputedStyle(probe).boxShadow;
			probe.remove();
			return { shadow: getComputedStyle(f).boxShadow, expected };
		});
		expect(shadow).toBe(expected);
	} finally {
		await context.close();
	}
});
