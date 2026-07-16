// UA-004: Note Dots are interactive (click opens the Expanded Note) but their
// hit area is the painted 6x6 circle - far below the 24x24 minimum
// (DESIGN.md 1.3). The fix extends the hit box invisibly; the painted dot
// must stay 6px and dots must keep swallowing events from the player. #173
// now tunes the box to the Note Band's tight 14 tall x 12 wide target, so the
// probes below assert its exact reach and bottom anchor.
//
// The extender grows UPWARD off the dot's bottom edge, not outward from its
// centre (#158): centred, its lower half hung inside YouTube's progress bar and
// swallowed every press near a Note's timestamp. So the reach is asserted
// above and to the sides, and the bar's own band is asserted to be OURS NO
// LONGER - the dot must not answer a hit test at or below its own bottom edge.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, playbackFixture, routeBackend, seedPaired } from './harness';

test('UA-004: every Note Dot offers the Note Band 12x14 hit area around a 6px glyph', async () => {
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
			const out: {
				id: string;
				glyph: number;
				reach: { dx: number; dy: number; hit: boolean }[];
				belowBottom: boolean;
				belowBar: boolean;
			}[] = [];
			const bar = document.querySelector<HTMLElement>('.ytp-progress-bar')!.getBoundingClientRect();
			for (const dot of document.querySelectorAll<HTMLElement>('.ytb-note-dot')) {
				const r = dot.getBoundingClientRect();
				const cx = r.left + r.width / 2;
				const cy = r.top + r.height / 2;
				const hitAt = (dx: number, dy: number) => {
					const el = document.elementFromPoint(cx + dx, cy + dy);
					return el === dot || dot.contains(el);
				};
				// Reach to 1px inside each edge of the 12px-wide x 14px-tall box.
				// The glyph itself occupies only +/-3px around the centre.
				const reach = [
					{ dx: -5, dy: 0 },
					{ dx: 5, dy: 0 },
					{ dx: 0, dy: -10 },
				].map(({ dx, dy }) => ({ dx, dy, hit: hitAt(dx, dy) }));
				out.push({
					id: dot.dataset.ytbNoteId || '?',
					glyph: r.width,
					reach,
					belowBottom: hitAt(0, r.bottom + 1 - cy),
					belowBar: hitAt(0, bar.top + 1 - cy),
				});
			}
			return out;
		});

		for (const { id, glyph, reach, belowBottom, belowBar } of results) {
			// The painted circle stays 6px - only the invisible hit box grows.
			expect.soft(glyph, `${id} glyph width`).toBe(6);
			for (const { dx, dy, hit } of reach) {
				expect.soft(hit, `${id} hit at (${dx},${dy}) from center`).toBe(true);
			}
			expect.soft(belowBottom, `${id} target must end at the dot's bottom edge`).toBe(false);
			expect.soft(belowBar, `${id} must not claim the bar beneath it`).toBe(false);
		}
	} finally {
		await context.close();
	}
});
