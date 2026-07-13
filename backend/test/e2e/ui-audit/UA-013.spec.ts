// UA-013: the cluster's focus indicator was a single white outline -
// invisible over a bright thumbnail (~1.09:1 on white). The indicator must
// carry a dark component too, so it reads on any thumbnail.
import { expect, test } from '@playwright/test';
import { launchExtension, nudgeUntil, watchedByDotsFixture, routeBackend, seedPaired } from './harness';

test('UA-013: the cluster focus indicator is two-tone', async () => {
	const context = await launchExtension();
	try {
		const now = Date.now();
		routeBackend(context, {
			down: false,
			read: () => ({
				progress: [{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-classic', timestamp: 55, duration: 100, updatedAt: now - 330_000 }],
			}),
		});
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: watchedByDotsFixture }),
		);
		await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		await nudgeUntil(page, () => document.querySelectorAll('.ytb-thumb-dots').length >= 1);
		const { outline, shadow } = await page.evaluate(() => {
			const el = document.querySelector<HTMLElement>('.ytb-thumb-dots')!;
			el.focus();
			const s = getComputedStyle(el);
			return { outline: s.outlineColor + ' ' + s.outlineStyle, shadow: s.boxShadow };
		});
		// A light outline stays...
		expect.soft(outline, `outline ${outline}`).toContain('solid');
		// ...and a dark shadow layer joins it, visible over bright thumbnails.
		expect.soft(shadow, `focus shadow ${shadow}`).toMatch(/rgba?\(0,\s*0,\s*0/);
	} finally {
		await context.close();
	}
});
