// UA-010: the Recommend strip is a YTB-branded surface and must consume the
// --ytb-* tokens like its siblings: the design face (YTB Rounded), theme-aware
// colors, a constant leading inset across its three states, the r-pill radius
// on its "Unrecommend" action, and token colors on its feedback line.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './harness';

test('UA-010: Recommend strip consumes the design tokens', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture }),
		);
		const popup = await seedPaired(context);
		const page = await context.newPage();
		const openStrip = async (videoId: string, state: string) => {
			await page.goto(`https://www.youtube.com/watch?v=${videoId}`);
			await nudgeUntil(page, () => Boolean(document.getElementById('ytb-note-button')));
			await page.click('#ytb-note-button');
			await expect(page.locator(`.ytb-recommend-strip${state}`)).toBeVisible();
			// The composer scales in; geometry is only true once that settles.
			await page.evaluate(() =>
				Promise.all(
					document
						.getElementById('ytb-note-composer')!
						.getAnimations()
						.map((a) => a.finished),
				),
			);
		};
		const strip = () =>
			page.evaluate(() => {
				const band = document.querySelector('.ytb-recommend-strip')!;
				const b = document.getElementById('ytb-playlist-add-button')!;
				const status = band.querySelector('.ytb-recommend-status')!;
				// The leading content: the status when there is one, else the idle label.
				const range = document.createRange();
				range.selectNodeContents(status.childNodes.length ? status : b.querySelector('.ytb-recommend-label')!);
				const s = getComputedStyle(b);
				return {
					fontFamily: s.fontFamily,
					faceLoaded: document.fonts.check(`700 13px 'YTB Rounded'`),
					color: s.color,
					radius: s.borderRadius,
					inset: range.getBoundingClientRect().left - band.getBoundingClientRect().left,
				};
			});

		// The design face, not a dead 'Nunito' reference falling back to Arial.
		await openStrip('fixture-video2', ':not(.is-added):not(.is-recommended)');
		const idle = await strip();
		expect(idle.fontFamily.split(',')[0].replace(/["']/g, '').trim()).toBe('YTB Rounded');
		expect(idle.faceLoaded).toBe(true);

		// Theme-aware: the idle label flips with the Theme Preference.
		await popup.evaluate(() => chrome.storage.local.set({ theme: 'dark' }));
		await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
		await expect.poll(async () => (await strip()).color).not.toBe(idle.color);
		await popup.evaluate(() => chrome.storage.local.set({ theme: 'light' }));
		await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

		// Constant leading inset across the three states (no shift on toggle).
		const insets: number[] = [idle.inset];
		await openStrip('vid-inroom', '.is-added');
		insets.push((await strip()).inset);
		await openStrip('vid-own', '.is-recommended');
		const own = await strip();
		insets.push(own.inset);
		expect(new Set(insets.map((v) => v.toFixed(2))).size, `leading insets ${insets.join(', ')}`).toBe(1);
		// The "Unrecommend" action takes the r-pill radius.
		expect(own.radius).toBe('999px');

		// The feedback line wears the shared danger-text and surface tokens. Force
		// a network-failed un-recommend (vid-own is the viewer's) to surface it.
		await routeBackend(context, { down: false, read: () => d }); // re-register AFTER the write-abort route below
		await context.route('http://localhost:8787/playlist**', (route) =>
			route.request().method() === 'DELETE' ? route.abort('connectionrefused') : route.fallback(),
		);
		await page.click('#ytb-playlist-add-button');
		await page.waitForSelector('.ytb-recommend-strip #ytb-playlist-feedback', { timeout: 10_000 });
		const { actual, expected } = await page.evaluate(() => {
			const f = document.getElementById('ytb-playlist-feedback')!;
			const probe = document.createElement('div');
			probe.style.color = 'var(--ytb-danger-text)';
			probe.style.background = 'var(--ytb-surface)';
			document.body.appendChild(probe);
			const p = getComputedStyle(probe);
			const expected = { color: p.color, background: p.backgroundColor };
			probe.remove();
			const s = getComputedStyle(f);
			return { actual: { color: s.color, background: s.backgroundColor }, expected };
		});
		expect(actual).toEqual(expected);
	} finally {
		await context.close();
	}
});
