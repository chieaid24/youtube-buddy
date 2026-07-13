// UA-014: every control inside the Room Home Section shows the apricot
// --ytb-ring focus indicator at one width (3px, the dominant value). Red
// while the title links, card titles, thumbs, and Dismiss fall back to the
// UA default outline and two rings render 2px.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, homeFixture, PIXEL_PNG, routeBackend, seedPaired } from './harness';

const CONTROLS = [
	'.ytb-hs-close',
	'.ytb-hs-more, .ytb-hs-text-link', // whichever renders in this fixture
	'a.ytb-hs-text-link',
	'a.ytb-hs-title-link',
	'.ytb-hs-card-title',
	'.ytb-hs-thumb',
	'.ytb-hs-remove',
];

test('UA-014: home-section controls share the 3px apricot focus ring', async () => {
	const context = await launchExtension();
	try {
		const d = makeData(Date.now());
		routeBackend(context, { down: false, read: () => d });
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG }));
		await seedPaired(context);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		await nudgeUntil(page, () => document.querySelectorAll('#ytb-home-section .ytb-hs-card').length >= 2);

		const results = await page.evaluate((selectors) => {
			const ringProbe = document.createElement('div');
			ringProbe.style.color = 'var(--ytb-ring)';
			document.getElementById('ytb-home-section')!.appendChild(ringProbe);
			const ring = getComputedStyle(ringProbe).color;
			ringProbe.remove();
			const out: { selector: string; shadow: string }[] = [];
			for (const selector of selectors) {
				const el = document.querySelector<HTMLElement>(`#ytb-home-section ${selector}`);
				if (!el) continue;
				el.focus();
				out.push({ selector, shadow: getComputedStyle(el).boxShadow });
			}
			return { ring, out };
		}, CONTROLS);

		expect(results.out.length).toBeGreaterThanOrEqual(5);
		for (const { selector, shadow } of results.out) {
			expect.soft(shadow, `${selector} ring: ${shadow}`).toContain(results.ring.replace('rgb(', 'rgba(').replace(')', ''));
			expect.soft(shadow, `${selector} width: ${shadow}`).toContain('0px 0px 0px 3px');
		}
	} finally {
		await context.close();
	}
});
