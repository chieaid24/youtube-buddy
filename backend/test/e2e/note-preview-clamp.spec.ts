// #181: a Note Preview is centred on its dot; near the bar's ends the card (up to
// 240px) overflowed the player and was clipped by the viewport - the body's first
// characters were simply cut off. The fix slides the card back inside the player
// with a small inset (--ytb-preview-shift), while keeping the unfold growing out of
// the dot and the ::before hover bridge anchored over the dot.
//
// This probe uses a player whose width tracks the progress bar (as on real
// YouTube, where the bar nearly spans the player), so a card at ~4% and ~96%
// genuinely overflows and the clamp must engage. A mid-bar card must not move.
import { expect, test, type Page } from '@playwright/test';
import { launchExtension, mediaSrc, nudgeUntil, routeBackend, seedPaired, VIEWER } from './ui-audit/harness';

// A bounded player (left:40 -> right:520) with the bar spanning all but a 12px
// inset each side, so a 240px card at either end spills past the player edge.
const narrowPlayerFixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>clamp fixture</title><style>body { margin: 0 }</style></head>
  <body>
    <main id="movie_player" class="html5-video-player" style="position: absolute; left: 40px; top: 20px; width: 480px; height: 270px; background: #000">
      <video src="${mediaSrc}" preload="auto"></video>
      <div class="ytp-chrome-bottom" style="position: absolute; left: 12px; right: 12px; bottom: 8px">
        <div class="ytp-progress-bar" style="position: relative; width: 456px; height: 6px; background: #444"></div>
        <div class="ytp-left-controls"></div>
      </div>
    </main>
  </body>
</html>`;

const LONG = 'This whole stretch is the best part of the entire video, do not skip it';
// duration comes from the 20s fixture video, so these land at ~4% / 50% / 96%.
const notes = [
	{
		id: 'n-start',
		clientId: 'buddy-1',
		name: 'Sam',
		videoId: 'fixture-video',
		timestamp: 0.8,
		kind: 'text',
		body: LONG,
		spoiler: false,
		createdAt: 1,
	},
	{
		id: 'n-mid',
		clientId: 'buddy-1',
		name: 'Sam',
		videoId: 'fixture-video',
		timestamp: 10,
		kind: 'text',
		body: LONG,
		spoiler: false,
		createdAt: 1,
	},
	{
		id: 'n-end',
		clientId: 'buddy-1',
		name: 'Sam',
		videoId: 'fixture-video',
		timestamp: 19.2,
		kind: 'text',
		body: LONG,
		spoiler: false,
		createdAt: 1,
	},
];

type Measure = {
	shift: number;
	previewLeft: number;
	previewRight: number;
	previewWidth: number;
	playerLeft: number;
	playerRight: number;
	dotCenter: number;
	originScreenX: number;
};

async function hoverAndMeasure(page: Page, noteId: string): Promise<Measure> {
	await page.locator(`.ytb-note-dot[data-ytb-note-id="${noteId}"]`).hover({ force: true });
	await page.waitForTimeout(400); // let the unfold settle to full scale
	return page.evaluate((id) => {
		const dot = document.querySelector(`.ytb-note-dot[data-ytb-note-id="${id}"]`)!;
		const preview = dot.querySelector('.ytb-note-preview')! as HTMLElement;
		const player = document.querySelector('#movie_player')!;
		const p = preview.getBoundingClientRect();
		const pl = player.getBoundingClientRect();
		const dr = dot.getBoundingClientRect();
		const cs = getComputedStyle(preview);
		const shift = parseFloat(cs.getPropertyValue('--ytb-preview-shift')) || 0;
		// transform-origin resolves to "<x>px <y>px": its x is a local offset from the
		// preview's left edge, so its screen projection must land on the dot.
		const originLocalX = parseFloat(cs.transformOrigin);
		return {
			shift,
			previewLeft: p.left,
			previewRight: p.right,
			previewWidth: p.width,
			playerLeft: pl.left,
			playerRight: pl.right,
			dotCenter: dr.left + dr.width / 2,
			originScreenX: p.left + originLocalX,
		};
	}, noteId);
}

test('#181: an edge Note Preview clamps inside the player, still unfolding from its dot', async () => {
	const context = await launchExtension();
	try {
		routeBackend(context, {
			down: false,
			read: () => ({ presence: [{ clientId: VIEWER, name: 'Alex', updatedAt: 1 }], notes }),
		});
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: narrowPlayerFixture }),
		);
		await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await nudgeUntil(page, () => document.querySelectorAll('.ytb-note-dot').length >= 3);

		const start = await hoverAndMeasure(page, 'n-start');
		const mid = await hoverAndMeasure(page, 'n-mid');
		const end = await hoverAndMeasure(page, 'n-end');
		const T = 0.6; // sub-pixel rounding tolerance

		// The card near the start would overflow the player's LEFT edge; the clamp
		// pushes it right so it sits fully inside, at the 8px inset.
		expect(start.shift, 'start card shifts right').toBeGreaterThan(0);
		expect(start.previewLeft, 'start card inside left').toBeGreaterThanOrEqual(start.playerLeft - T);
		expect(start.previewRight, 'start card inside right').toBeLessThanOrEqual(start.playerRight + T);

		// The card near the end would overflow the player's RIGHT edge; the clamp
		// pulls it left so it sits fully inside.
		expect(end.shift, 'end card shifts left').toBeLessThan(0);
		expect(end.previewLeft, 'end card inside left').toBeGreaterThanOrEqual(end.playerLeft - T);
		expect(end.previewRight, 'end card inside right').toBeLessThanOrEqual(end.playerRight + T);

		// A mid-bar card fits already: no shift, and it stays centred on its dot
		// (pixel-identical to before the fix).
		expect(mid.shift, 'mid card is not shifted').toBe(0);
		expect(Math.abs(mid.previewLeft + mid.previewWidth / 2 - mid.dotCenter), 'mid card centred on dot').toBeLessThan(T);

		// At every position - shifted or not - the unfold origin sits on the dot, so
		// a clamped card still grows out of its dot rather than its own centre.
		for (const [label, m] of [
			['start', start],
			['mid', mid],
			['end', end],
		] as const) {
			expect(Math.abs(m.originScreenX - m.dotCenter), `${label} unfold origin on dot`).toBeLessThan(T);
		}
	} finally {
		await context.close();
	}
});
