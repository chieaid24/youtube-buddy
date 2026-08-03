// UA-017: the Room Home Section's spacing, radii, and type sit on the token
// scales (4/8/12/16/20/24, radii 8/12/16/999, type 11/13/15/16). Red while
// the injected stylesheet hardcodes 10, 6, 5, 3, 1px spacing, 10px radii,
// and 10px/12px type. The Connection Lost line's negative positioning shim
// is placement, not rhythm, and is not asserted.
import { expect, test } from '@playwright/test';
import { launchExtension, makeData, nudgeUntil, openHomePanel, homeFixture, PIXEL_PNG, routeBackend, seedPaired } from './harness';

const SCALE = new Set([0, 4, 8, 12, 16, 20, 24]);
const RADII = new Set([8, 12, 16, 999]);
const SIZES = new Set([11, 13, 15, 16]);

const SPACING: [string, string[]][] = [
	['#ytb-home-section', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
	['#ytb-home-section .ytb-hs-feed-scroll', ['padding-top', 'padding-left']],
	['#ytb-home-section .ytb-hs-day', ['margin-top', 'margin-bottom']],
	['#ytb-home-section .ytb-hs-item', ['margin-top', 'margin-bottom']],
	['#ytb-home-section .ytb-hs-when', ['margin-left']],
	['#ytb-home-section .ytb-hs-pl-row', ['gap']],
	['#ytb-home-section .ytb-hs-card-title', ['margin-top']],
	['#ytb-home-section .ytb-hs-watched', ['margin-top']],
	['#ytb-home-section .ytb-hs-btn', ['padding-top', 'padding-left']],
	['#ytb-home-section .ytb-hs-input', ['padding-top', 'padding-left']],
];
const TYPE = ['.ytb-hs-day', '.ytb-hs-when', '.ytb-hs-watched', '.ytb-hs-empty'];

test('UA-017: home-section values sit on the token scales', async () => {
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
		await openHomePanel(page);
		await nudgeUntil(page, () => document.querySelectorAll('#ytb-home-section .ytb-hs-card').length >= 2);

		const rows = await page.evaluate(
			({ spacing, type }) => {
				const out: { key: string; value: number; kind: string }[] = [];
				for (const [selector, properties] of spacing) {
					const el = document.querySelector(selector);
					if (!el) continue;
					const s = getComputedStyle(el);
					for (const p of properties) out.push({ key: `${selector} ${p}`, value: parseFloat(s.getPropertyValue(p)), kind: 'space' });
				}
				const thumb = document.querySelector('#ytb-home-section .ytb-hs-thumb');
				if (thumb) out.push({ key: 'thumb radius', value: parseFloat(getComputedStyle(thumb).borderTopLeftRadius), kind: 'radius' });
				for (const sel of type) {
					const el = document.querySelector(`#ytb-home-section ${sel}`);
					if (!el) continue;
					out.push({ key: `${sel} font-size`, value: parseFloat(getComputedStyle(el).fontSize), kind: 'type' });
				}
				return out;
			},
			{ spacing: SPACING, type: TYPE },
		);
		expect(rows.length).toBeGreaterThanOrEqual(18);
		for (const { key, value, kind } of rows) {
			const set = kind === 'space' ? SCALE : kind === 'radius' ? RADII : SIZES;
			expect.soft(set.has(Math.round(value)), `${key}: ${value}px`).toBe(true);
		}
	} finally {
		await context.close();
	}
});
