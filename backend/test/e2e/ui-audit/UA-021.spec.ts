// UA-021: the connection-lost "Retrying..." line matches its secondary-line
// twins (11px/500 ink-muted, like the room-full sub-line and every .set-sub).
// Red while the muted styling is scoped to [data-state='full'] only and the
// retrying line renders 13px full-strength ink.
import { expect, test } from '@playwright/test';
import { launchExtension, routeBackend, seedPaired } from './harness';

test('UA-021: the retrying line shares the muted secondary styling', async () => {
	const context = await launchExtension();
	try {
		const state = { down: true, read: () => ({}) };
		routeBackend(context, state);
		const popup = await seedPaired(context);
		await popup.reload();
		await popup.waitForFunction(() => (document.getElementById('status-sub')?.textContent || '').includes('Retrying'), null, {
			timeout: 25_000,
		});
		const { size, color, muted } = await popup.evaluate(() => {
			const el = document.getElementById('status-sub')!;
			const probe = document.createElement('span');
			probe.style.color = 'var(--c-ink-muted)';
			document.body.appendChild(probe);
			const muted = getComputedStyle(probe).color;
			probe.remove();
			const s = getComputedStyle(el);
			return { size: parseFloat(s.fontSize), color: s.color, muted };
		});
		expect.soft(size, `status-sub font-size ${size}`).toBe(11);
		expect.soft(color, 'status-sub muted color').toBe(muted);
	} finally {
		await context.close();
	}
});
