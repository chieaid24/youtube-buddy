// UA-026: under prefers-reduced-motion the Unseen halo stops pulsing and
// degrades to a static ring, which is then the viewer's ONLY Unseen cue. Laid
// flush against the dot that ring scored 1.01-2.51:1 on every Buddy Color
// (1.06:1 on #f0a500) and read as one fatter dot. The fix holds it off the fill
// with a 1px #0f0f0f gap; this probe asserts both edges of that ring clear 3:1
// for every palette color in both themes, and that the dot still never resizes.
import { expect, test } from '@playwright/test';
import { contrastRatio, launchExtension, makeData, nudgeUntil, playbackFixture, resolveColor, routeBackend, seedPaired } from './harness';

const PALETTE = ['#00a6d6', '#f0a500', '#7655d6', '#00a86b', '#e85d04', '#d936c7', '#558b2f', '#4776e6'];
const MIN_RATIO = 3;

/** Computed box-shadow of the Unseen dot, split into its color+spread layers. */
async function ringLayers(page: import('@playwright/test').Page, noteId: string) {
	return page.evaluate((id) => {
		const dot = document.querySelector<HTMLElement>(`.ytb-note-dot[data-ytb-note-id="${id}"]`);
		if (!dot) throw new Error('missing unseen dot ' + id);
		const style = getComputedStyle(dot);
		// Split on top-level commas only: a layer's color is itself a comma-bearing
		// function (rgb(...)), and Chromium leaves the accent as oklch(...) here.
		const parts: string[] = [];
		let depth = 0;
		let buf = '';
		for (const ch of style.boxShadow) {
			if (ch === '(') depth++;
			if (ch === ')') depth--;
			if (ch === ',' && depth === 0) {
				parts.push(buf);
				buf = '';
			} else buf += ch;
		}
		if (buf.trim()) parts.push(buf);
		// Each layer reads "<color> <offset-x> <offset-y> <blur> <spread>"; no color
		// function carries a px length, so the lengths are the trailing run.
		const layers = parts.map((part) => {
			const m = part.trim().match(/^(.*?)\s+((?:-?[\d.]+px\s*)+)$/);
			const lengths = (m?.[2] || '').trim().split(/\s+/);
			return { color: (m?.[1] || part).trim(), spread: lengths.length === 4 ? Number.parseFloat(lengths[3]) : 0 };
		});
		return {
			layers,
			animationName: style.animationName,
			fill: style.backgroundColor,
			width: dot.getBoundingClientRect().width,
			unseen: dot.classList.contains('ytb-note-dot-unseen'),
		};
	}, noteId);
}

test('UA-026: the reduced-motion Unseen ring stays legible on every Buddy Color', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture }),
		);
		const popup = await seedPaired(context);
		const page = await context.newPage();
		// The pulse is off, so the static ring is the whole Unseen signal.
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		// n-mention is authored by buddy-2 and mentions the viewer: an Unseen dot.
		await nudgeUntil(page, () => !!document.querySelector('.ytb-note-dot[data-ytb-note-id="n-mention"].ytb-note-dot-unseen'));

		for (const theme of ['light', 'dark'] as const) {
			await popup.evaluate((t) => chrome.storage.local.set({ theme: t }), theme);
			await expect.poll(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme)).toBe(true);

			for (const color of PALETTE) {
				await popup.evaluate(
					([c]) => chrome.storage.local.set({ buddyColors: { 'silly-otters': { 'buddy-1': '#00a6d6', 'buddy-2': c } } }),
					[color],
				);
				const expected = await resolveColor(page, color);
				const expectedFill = `rgb(${expected[0]}, ${expected[1]}, ${expected[2]})`;
				await expect
					.poll(() =>
						page.evaluate(
							(c) => getComputedStyle(document.querySelector('.ytb-note-dot[data-ytb-note-id="n-mention"]')!).backgroundColor === c,
							expectedFill,
						),
					)
					.toBe(true);

				const { layers, animationName, fill, width, unseen } = await ringLayers(page, 'n-mention');
				const where = `${theme}/${color}`;

				expect.soft(unseen, `${where} dot still Unseen`).toBe(true);
				expect.soft(animationName, `${where} pulse is off under reduced motion`).toBe('none');
				// The dot itself never grows: the ring is painted outside the layout box.
				expect.soft(width, `${where} glyph width`).toBe(6);

				// Two layers, innermost first: the gap hugs the fill, the accent ring sits outside it.
				expect.soft(layers.length, `${where} ring has a gap layer and an accent layer`).toBe(2);
				const [gap, ring] = layers;
				expect.soft(gap.spread, `${where} gap spread`).toBe(1);
				expect.soft(ring.spread, `${where} ring spread`).toBe(3);

				const gapRgb = await resolveColor(page, gap.color);
				const ringRgb = await resolveColor(page, ring.color);
				const fillRgb = await resolveColor(page, fill);

				// Both edges of the separator must be visible, or the ring merges into
				// something: the dot on one side, the ring on the other.
				expect.soft(contrastRatio(gapRgb, fillRgb), `${where} gap vs Buddy Color fill`).toBeGreaterThanOrEqual(MIN_RATIO);
				expect.soft(contrastRatio(ringRgb, gapRgb), `${where} accent ring vs gap`).toBeGreaterThanOrEqual(MIN_RATIO);
			}
		}
	} finally {
		await context.close();
	}
});
