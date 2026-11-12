// UA-019: popup type sits on the declared 11/13/15/16 scale.
import { expect, test } from '@playwright/test';
import { launchExtension, seedPaired } from './harness';

const SIZES = new Set([11, 13, 15, 16]);
const SELECTORS = ['#your-room', '.feedback'];

test('UA-019: popup type sits on the declared scale', async () => {
	const context = await launchExtension();
	try {
		const popup = await seedPaired(context);
		await popup.reload();
		const sizes = await popup.evaluate(
			(sels) => sels.map((sel) => ({ sel, size: parseFloat(getComputedStyle(document.querySelector(sel)!).fontSize) })),
			SELECTORS,
		);
		for (const { sel, size } of sizes) {
			expect.soft(SIZES.has(size), `${sel} font-size ${size}px`).toBe(true);
		}
	} finally {
		await context.close();
	}
});
