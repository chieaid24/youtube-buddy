// UA-004: Note Dots are interactive (click opens the Expanded Note) but their
// hit area is the painted 6x6 circle - far below the 24x24 minimum
// (DESIGN.md 1.3). The fix extends the hit box invisibly; the painted dot
// must stay 6px and dots must keep swallowing events from the player.
//
// The extender grows UPWARD off the dot's bottom edge, not outward from its
// centre (#158): centred, its lower half hung inside YouTube's progress bar and
// swallowed every press near a Note's timestamp. So the 24px reach is asserted
// above and to the sides, and the bar's own band is asserted to be OURS NO
// LONGER - the dot must not answer a hit test at or below its own bottom edge.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './harness';

test('UA-004: every Note Dot offers a >= 24x24 hit area around a 6px glyph', async () => {
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

		const results = await page.evaluate(() => {
			const out: { id: string; glyph: number; reach: { dx: number; dy: number; hit: boolean }[]; belowBar: boolean }[] = [];
			for (const dot of document.querySelectorAll<HTMLElement>('.ytb-note-dot')) {
				const r = dot.getBoundingClientRect();
				const cx = r.left + r.width / 2;
				const cy = r.top + r.height / 2;
				const hitAt = (dx: number, dy: number) => {
					const el = document.elementFromPoint(cx + dx, cy + dy);
					return el === dot || dot.contains(el);
				};
				// 11px to each side, and 11px then 20px UP: a 24px-wide box that
				// reaches a full 24px above the dot's bottom edge (1px of rounding
				// margin), all of it clear of the bar.
				const reach = [
					{ dx: -11, dy: 0 },
					{ dx: 11, dy: 0 },
					{ dx: 0, dy: -11 },
					{ dx: 0, dy: -20 },
				].map(({ dx, dy }) => ({ dx, dy, hit: hitAt(dx, dy) }));
				// The dot's bottom edge sits 3px above the bar; 7px below its centre
				// is INSIDE the bar, and must belong to YouTube's scrubber (#158).
				out.push({ id: dot.dataset.ytbNoteId || '?', glyph: r.width, reach, belowBar: hitAt(0, 7) });
			}
			return out;
		});

		for (const { id, glyph, reach, belowBar } of results) {
			// The painted circle stays 6px - only the invisible hit box grows.
			expect.soft(glyph, `${id} glyph width`).toBe(6);
			for (const { dx, dy, hit } of reach) {
				expect.soft(hit, `${id} hit at (${dx},${dy}) from center`).toBe(true);
			}
			expect.soft(belowBar, `${id} must not claim the bar beneath it`).toBe(false);
		}
	} finally {
		await context.close();
	}
});
