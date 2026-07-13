// UA-004: Note Dots are interactive (click opens the Expanded Note) but their
// hit area is the painted 6x6 circle - far below the 24x24 minimum
// (DESIGN.md 1.3). The fix extends the hit box invisibly; the painted dot
// must stay 6px and dots must keep swallowing events from the player.
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
			const out: { id: string; glyph: number; reach: { dx: number; dy: number; hit: boolean }[] }[] = [];
			for (const dot of document.querySelectorAll<HTMLElement>('.ytb-note-dot')) {
				const r = dot.getBoundingClientRect();
				const cx = r.left + r.width / 2;
				const cy = r.top + r.height / 2;
				// 11px from center in each axis direction = a 22px-diameter cross,
				// within a 24x24 box with 1px margin for rounding.
				const reach = [
					{ dx: -11, dy: 0 },
					{ dx: 11, dy: 0 },
					{ dx: 0, dy: -11 },
					{ dx: 0, dy: 11 },
				].map(({ dx, dy }) => {
					const el = document.elementFromPoint(cx + dx, cy + dy);
					return { dx, dy, hit: el === dot || dot.contains(el) };
				});
				out.push({ id: dot.dataset.ytbNoteId || '?', glyph: r.width, reach });
			}
			return out;
		});

		for (const { id, glyph, reach } of results) {
			// The painted circle stays 6px - only the invisible hit box grows.
			expect.soft(glyph, `${id} glyph width`).toBe(6);
			for (const { dx, dy, hit } of reach) {
				expect.soft(hit, `${id} hit at (${dx},${dy}) from center`).toBe(true);
			}
		}
	} finally {
		await context.close();
	}
});
