import { expect, test, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';

const extensionPath = path.resolve(__dirname, '../../../extension');

const fixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>YouTube fixture</title></head>
  <body>
    <main id="movie_player" class="html5-video-player">
      <video></video>
      <div class="ytp-chrome-bottom">
        <div class="ytp-progress-bar"></div>
        <div class="ytp-left-controls"></div>
      </div>
    </main>
    <a href="/watch?v=fixture-next"><img alt="Fixture thumbnail"></a>
  </body>
</html>`;

/** A silent PCM WAV as a data URI — a real media source with a known duration,
 * so the fixture <video>'s `duration` is native state every JS world can see. */
function silentWavDataUri(seconds: number): string {
	const rate = 8000;
	const samples = rate * seconds;
	const wav = Buffer.alloc(44 + samples);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(36 + samples, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16); // PCM chunk size
	wav.writeUInt16LE(1, 20); // PCM format
	wav.writeUInt16LE(1, 22); // mono
	wav.writeUInt32LE(rate, 24); // sample rate
	wav.writeUInt32LE(rate, 28); // byte rate (8-bit mono)
	wav.writeUInt16LE(1, 32); // block align
	wav.writeUInt16LE(8, 34); // bits per sample
	wav.write('data', 36);
	wav.writeUInt32LE(samples, 40);
	wav.fill(128, 44); // 8-bit silence midpoint
	return 'data:audio/wav;base64,' + wav.toString('base64');
}

async function launchExtension(): Promise<BrowserContext> {
	return chromium.launchPersistentContext('', {
		channel: 'chromium',
		headless: true,
		args: [
			`--disable-extensions-except=${extensionPath}`,
			`--load-extension=${extensionPath}`,
			// The dot-click playback test drives play() from evaluate(), which
			// carries no user gesture.
			'--autoplay-policy=no-user-gesture-required',
		],
	});
}

function collectErrors(context: BrowserContext) {
	const errors: string[] = [];
	const attach = (page: Page) => {
		page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(`${page.url()}: ${message.text()}`);
		});
	};
	context.pages().forEach(attach);
	context.on('page', attach);
	return errors;
}

async function extensionItem(page: Page) {
	await page.goto('chrome://extensions/');
	const item = page.locator('extensions-item').filter({ hasText: 'YouTube Buddy' });
	await expect(item).toHaveCount(1);
	return item;
}

// Content-script fetches run under the page origin, so backend stubs must
// answer CORS like the real Worker does.
const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
	'access-control-allow-headers': 'content-type',
};

/**
 * Stand in for the backend Worker: every GET returns the one fixed Room read
 * built from `read`; writes are acknowledged with `{ ok: true }`. Records each
 * request as "METHOD url body" into `calls` so tests can assert what hit the
 * wire (the body part is omitted for body-less requests).
 *
 * `POST /notes` answers like the real route does — with the complete server
 * record (`{ ok, id, note }`) — because the extension reconciles the Video
 * Timeline and fires the Post Echo off that record, not off a bare ack.
 */
function stubRoomBackend(
	context: BrowserContext,
	read: { notes?: object[]; replies?: object[]; playlist?: object[]; progress?: object[]; events?: object[] },
	calls: string[] = [],
) {
	let posted = 0;
	return context.route('http://localhost:8787/**', (route) => {
		const request = route.request();
		const body = request.postData();
		calls.push(`${request.method()} ${request.url()}${body ? ` ${body}` : ''}`);
		if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
		if (request.method() === 'GET') {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				headers: CORS,
				body: JSON.stringify({
					progress: read.progress ?? [],
					presence: [],
					notes: read.notes ?? [],
					replies: read.replies ?? [],
					playlist: read.playlist ?? [],
					events: read.events ?? [],
				}),
			});
		}
		if (request.method() === 'POST' && new URL(request.url()).pathname === '/notes') {
			const id = `posted-${++posted}`;
			const note = { id, spoiler: false, ...JSON.parse(body ?? '{}'), createdAt: Date.now() };
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				headers: CORS,
				body: JSON.stringify({ ok: true, id, note }),
			});
		}
		return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: true }) });
	});
}

/**
 * Seed the paired-Room config through an extension page (chrome.storage is
 * only reachable from the extension's own origin). Returns the popup page so
 * tests can keep reading chrome.storage.local through it.
 */
async function seedPairedRoom(context: BrowserContext) {
	const extensions = await context.newPage();
	const extensionId = await (await extensionItem(extensions)).getAttribute('id');
	const popup = await context.newPage();
	await popup.goto(`chrome-extension://${extensionId}/popup.html`);
	// popup.js mints a clientId on open (read-then-write); wait for that write
	// to land or it would clobber the seeded clientId in a losing race.
	await popup.waitForFunction(async () => (await chrome.storage.local.get('clientId')).clientId);
	await popup.evaluate(() => chrome.storage.local.set({ code: 'roome2e', clientId: 'viewer-e2e', name: 'Viewer', sharing: false }));
	return popup;
}

/**
 * Retry an assertion while nudging the DOM, so content.js keeps re-emitting
 * ytb:mutation until the extension reconciles (initial renders can race the
 * fixture and the stubbed Room read).
 */
async function nudgeUntil(page: Page, assertion: () => Promise<void>) {
	await expect(async () => {
		await page.evaluate(() => document.body.appendChild(document.createComment('nudge')));
		await assertion();
	}).toPass({ timeout: 15_000 });
}

test('loads the unpacked extension and runs every content script', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await context.route('https://www.youtube.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');

		// The Add Note (+) button is gated on Room membership (#194): this fixture is
		// Unpaired, so it never mounts — though composer.js still ran (styles below).
		await expect(page.locator('#ytb-note-button')).toHaveCount(0);
		await expect(page.locator('#ytb-theme')).toHaveCount(1);
		await expect(page.locator('#ytb-renderer-style')).toHaveCount(1);
		await expect(page.locator('#ytb-notes-style')).toHaveCount(1);
		await expect(page.locator('#ytb-composer-styles')).toHaveCount(1);
		await expect(page.locator('#ytb-home-toggle-style')).toHaveCount(1);
		await expect(page.locator('#ytb-home-toggle')).toHaveCount(0); // guide row is home-route only
		await expect(page.locator('.ytb-thumb-dots')).toHaveCount(0);
		await page.waitForTimeout(750);
		const extensions = await context.newPage();
		const item = await extensionItem(extensions);
		await expect(item.locator('#errors-button')).toHaveCount(0);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// The feed thumbnail generations the Watched-By Dots must stay inside: a
// lockup tile whose /watch anchor is WIDER AND TALLER than its real thumbnail
// box (today's home/channel grids), a lockup tile carrying a simulated Watched
// Bar (the dots are top-left — fully decoupled from the bottom Watched Bar),
// and a classic tile whose anchor IS the thumbnail box (search). Plus a
// document-level ytd-video-preview host (hidden until the test reveals it)
// standing in for YouTube's hover-autoplay inline preview, with a high
// z-index player pane the dots must beat.
const watchedByDotsFixture = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"><title>YouTube watched-by-dots fixture</title>
    <style>
      body { margin: 0; padding: 24px; }
      ytd-rich-item-renderer, yt-lockup-view-model, yt-thumbnail-view-model,
      yt-thumbnail-bottom-overlay-view-model, ytd-video-preview { display: block; }
    </style>
  </head>
  <body>
    <ytd-rich-item-renderer>
      <yt-lockup-view-model>
        <a id="lockup-anchor" class="ytLockupViewModelContentImage" href="/watch?v=vid-lockup" style="display: block; width: 347px; height: 207px">
          <yt-thumbnail-view-model id="lockup-thumb" style="position: relative; overflow: hidden; width: 331px; height: 195px; border-radius: 12px; background: #222">
            <img alt="" style="display: block; width: 100%; height: 100%">
            <yt-thumbnail-bottom-overlay-view-model style="position: absolute; left: 0; right: 0; bottom: 0">
              <div id="lockup-badge" style="position: absolute; right: 8px; bottom: 8px; width: 34px; height: 18px; background: #000; border-radius: 4px"></div>
            </yt-thumbnail-bottom-overlay-view-model>
          </yt-thumbnail-view-model>
        </a>
      </yt-lockup-view-model>
    </ytd-rich-item-renderer>
    <ytd-rich-item-renderer>
      <yt-lockup-view-model>
        <a id="watched-anchor" href="/watch?v=vid-watched" style="display: block; width: 347px; height: 207px">
          <yt-thumbnail-view-model id="watched-thumb" style="position: relative; overflow: hidden; width: 331px; height: 195px; border-radius: 12px; background: #222">
            <img alt="" style="display: block; width: 100%; height: 100%">
            <yt-thumbnail-bottom-overlay-view-model style="position: absolute; left: 0; right: 0; bottom: 0">
              <div id="watched-bar" class="ytThumbnailOverlayProgressBarHostWatchedProgressBar" style="height: 4px; margin: 0 4px 4px 8px; border-radius: 2px; background: #f03"></div>
            </yt-thumbnail-bottom-overlay-view-model>
          </yt-thumbnail-view-model>
        </a>
      </yt-lockup-view-model>
    </ytd-rich-item-renderer>
    <a id="classic-anchor" href="/watch?v=vid-classic" style="display: block; width: 320px; height: 180px; background: #222; margin-top: 16px">
      <img alt="" style="display: block; width: 100%; height: 100%">
    </a>
    <a id="dup-anchor" href="/watch?v=vid-lockup" style="display: block; width: 320px; height: 180px; background: #222; margin-top: 16px">
      <img alt="" style="display: block; width: 100%; height: 100%">
    </a>
    <ytd-video-preview id="preview-host" style="display: none; position: fixed; left: 24px; top: 340px; width: 480px; height: 270px; z-index: 2200; background: #000">
      <a id="preview-anchor" href="/watch?v=vid-lockup" style="display: block; width: 100%; height: 100%">
        <img alt="" style="display: block; width: 100%; height: 100%">
      </a>
      <div id="preview-player" style="position: absolute; inset: 0; z-index: 50; background: #111"></div>
    </ytd-video-preview>
  </body>
</html>`;

test('the Watched-By Dots sit top-left inside the thumbnail box, label their Buddies, and survive the inline preview', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, {
			progress: [
				// Two branches of the Watch Status table on one tooltip: Sam floors
				// up to "5%" (a record never reads "0%"), Kim rounds past 80 to "Watched".
				{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-lockup', timestamp: 2, duration: 100, updatedAt: 1 },
				{ clientId: 'buddy-2', name: 'Kim', videoId: 'vid-lockup', timestamp: 95, duration: 100, updatedAt: 2 },
				// The viewer's own record must never grow a dot (YouTube's red
				// Watched Bar already tells the viewer's state).
				{ clientId: 'viewer-e2e', name: 'Viewer', videoId: 'vid-lockup', timestamp: 90, duration: 100, updatedAt: 9 },
				{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-watched', timestamp: 40, duration: 100, updatedAt: 3 },
				{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-classic', timestamp: 55, duration: 100, updatedAt: 4 },
			],
		});
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: watchedByDotsFixture }),
		);
		const popup = await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		const clusters = page.locator('.ytb-thumb-dots');
		await nudgeUntil(page, () => expect(clusters).toHaveCount(4, { timeout: 700 }));

		// The retired Progress Bar renders nowhere.
		await expect(page.locator('.ytb-thumb-bar')).toHaveCount(0);

		const rect = (selector: string) =>
			page.evaluate((sel) => {
				const r = document.querySelector(sel)!.getBoundingClientRect();
				return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
			}, selector);

		// Keyboard focus shows the tooltip (asserted before any pointer input so
		// :focus-visible matches). The cluster is a focusable labelled image whose
		// tooltip is one row per dot: a Buddy Color swatch, Display Name, Watch Status.
		const classicTip = page.locator('#classic-anchor .ytb-thumb-dots > .ytb-watch-tooltip');
		const classicRows = classicTip.locator('.ytb-thumb-row');
		await page.evaluate(() => document.querySelector<HTMLElement>('#classic-anchor .ytb-thumb-dots')!.focus());
		await expect(classicRows).toHaveCount(1);
		await expect(classicRows.nth(0).locator('.ytb-thumb-name')).toHaveText('Sam');
		await expect(classicRows.nth(0).locator('.ytb-thumb-status')).toHaveText('55%'); // 55/100 rounds to 55%
		// The accessible name mirrors the rows (name + status), for a screen reader.
		await expect(page.locator('#classic-anchor .ytb-thumb-dots')).toHaveAttribute('aria-label', 'Watched by Sam 55%');
		await expect.poll(() => classicTip.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
		// Focus settles the dots up (~1.25x) — a transform, not a layout change.
		expect(await page.evaluate(() => getComputedStyle(document.querySelector('#classic-anchor .ytb-thumb-dot')!).transform)).not.toBe(
			'none',
		);
		await page.evaluate(() => document.querySelector<HTMLElement>('#classic-anchor .ytb-thumb-dots')!.blur());

		// Lockup tile: the cluster lives inside the REAL thumbnail box — never
		// the larger anchor — its dots inset 8px from the box's top-left, one
		// flat dot per Buddy (the viewer excluded), newest watcher first.
		const lockupThumb = await rect('#lockup-thumb');
		const lockupDots = page.locator('#lockup-thumb .ytb-thumb-dot');
		await expect(lockupDots).toHaveCount(2);
		await expect(page.locator('#lockup-anchor > .ytb-thumb-dots')).toHaveCount(0);
		expect(await lockupDots.evaluateAll((dots) => dots.map((d) => (d as HTMLElement).dataset.ytbCid))).toEqual(['buddy-2', 'buddy-1']);
		const firstDot = await rect('#lockup-thumb .ytb-thumb-dot');
		expect(firstDot.left).toBeCloseTo(lockupThumb.left + 8, 1);
		expect(firstDot.top).toBeCloseTo(lockupThumb.top + 8, 1);
		expect(firstDot.width).toBeCloseTo(8, 1);
		expect(await page.evaluate(() => getComputedStyle(document.querySelector('#lockup-thumb .ytb-thumb-dot')!).borderRadius)).toBe('50%');
		// The box already establishes a positioning context, so no YouTube element
		// is mutated to position: relative.
		expect(await page.evaluate(() => document.querySelector<HTMLElement>('#lockup-anchor')!.style.position)).toBe('');

		// The whole cluster (its padded hover target included) never overhangs
		// the image box.
		const lockupCluster = await rect('#lockup-thumb .ytb-thumb-dots');
		expect(lockupCluster.left).toBeGreaterThanOrEqual(lockupThumb.left);
		expect(lockupCluster.top).toBeGreaterThanOrEqual(lockupThumb.top);
		expect(lockupCluster.right).toBeLessThanOrEqual(lockupThumb.right);
		expect(lockupCluster.bottom).toBeLessThanOrEqual(lockupThumb.bottom);

		// Hover shows the dark tooltip's rows — one per dot, most recent watcher
		// first, no "You" for the viewer's own record — each with its Watch Status,
		// fully inside the box.
		await page.locator('#lockup-thumb .ytb-thumb-dots').hover();
		const tip = page.locator('#lockup-thumb .ytb-thumb-dots > .ytb-watch-tooltip');
		const lockupRows = tip.locator('.ytb-thumb-row');
		await expect(lockupRows).toHaveCount(2);
		await expect(lockupRows.nth(0).locator('.ytb-thumb-name')).toHaveText('Kim');
		await expect(lockupRows.nth(0).locator('.ytb-thumb-status')).toHaveText('Watched'); // 95/100 rounds past 80
		await expect(lockupRows.nth(1).locator('.ytb-thumb-name')).toHaveText('Sam');
		await expect(lockupRows.nth(1).locator('.ytb-thumb-status')).toHaveText('5%'); // 2/100 floors up
		await expect(page.locator('#lockup-thumb .ytb-thumb-dots')).toHaveAttribute('aria-label', 'Watched by Kim Watched, Sam 5%');
		await expect.poll(() => tip.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
		const tipRect = await rect('#lockup-thumb .ytb-thumb-dots > .ytb-watch-tooltip');
		expect(tipRect.left).toBeGreaterThanOrEqual(lockupThumb.left);
		expect(tipRect.right).toBeLessThanOrEqual(lockupThumb.right);
		await page.mouse.move(0, 0);

		// Watched tile: the dots are decoupled from the bottom Watched Bar —
		// top-left, nowhere near it, and the Watched Bar itself is untouched.
		const watchedThumb = await rect('#watched-thumb');
		const watchedDot = await rect('#watched-thumb .ytb-thumb-dot');
		expect(watchedDot.left).toBeCloseTo(watchedThumb.left + 8, 1);
		expect(watchedDot.top).toBeCloseTo(watchedThumb.top + 8, 1);
		await expect(page.locator('#watched-thumb .ytb-thumb-dot')).toHaveCount(1);

		// Classic tile (the anchor IS the thumbnail box — search): same corner.
		const classic = await rect('#classic-anchor');
		const classicDot = await rect('#classic-anchor .ytb-thumb-dot');
		expect(classicDot.left).toBeCloseTo(classic.left + 8, 1);
		expect(classicDot.top).toBeCloseTo(classic.top + 8, 1);

		// Autoplay survival, in-box flavor: a high z-index pane covering the
		// whole box (an inline preview player mounting inside the tile) must not
		// bury the dots — they stay on top and stay hoverable.
		await page.evaluate(() => {
			const cover = document.createElement('div');
			cover.id = 'inline-cover';
			cover.style.cssText = 'position: absolute; inset: 0; z-index: 500; background: rgba(0, 0, 0, 0.4)';
			document.querySelector('#lockup-thumb')!.appendChild(cover);
		});
		expect(
			await page.evaluate(() => {
				const cluster = document.querySelector('#lockup-thumb .ytb-thumb-dots')!;
				const r = cluster.getBoundingClientRect();
				const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
				return cluster === hit || cluster.contains(hit);
			}),
		).toBe(true);
		await page.locator('#lockup-thumb .ytb-thumb-dots').hover();
		await expect.poll(() => tip.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
		await page.mouse.move(0, 0);
		await page.evaluate(() => document.querySelector('#inline-cover')!.remove());

		// Autoplay survival, overlay flavor: a document-level ytd-video-preview
		// host covering the tile gets the cluster mirrored INTO it, above its
		// player pane, tooltip intact; it disappears with the preview.
		await page.evaluate(() => {
			document.querySelector<HTMLElement>('#preview-host')!.style.display = 'block';
		});
		const previewCluster = page.locator('#preview-host .ytb-thumb-dots');
		await nudgeUntil(page, () => expect(previewCluster).toHaveCount(1, { timeout: 700 }));
		await expect(page.locator('#preview-host .ytb-thumb-dot')).toHaveCount(2);
		expect(
			await page.evaluate(() => {
				const cluster = document.querySelector('#preview-host .ytb-thumb-dots')!;
				const r = cluster.getBoundingClientRect();
				const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
				return cluster === hit || cluster.contains(hit);
			}),
		).toBe(true);
		await previewCluster.hover();
		const previewTip = page.locator('#preview-host .ytb-thumb-dots > .ytb-watch-tooltip');
		const previewRows = previewTip.locator('.ytb-thumb-row');
		await expect(previewRows).toHaveCount(2);
		await expect(previewRows.nth(0).locator('.ytb-thumb-name')).toHaveText('Kim');
		await expect(previewRows.nth(0).locator('.ytb-thumb-status')).toHaveText('Watched');
		await expect(previewRows.nth(1).locator('.ytb-thumb-name')).toHaveText('Sam');
		await expect(previewRows.nth(1).locator('.ytb-thumb-status')).toHaveText('5%');
		await expect.poll(() => previewTip.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
		await page.mouse.move(0, 0);

		// Ownership (#174), pairing half: the host at its fixture spot shares
		// vid-lockup with two tiles but geometrically covers NEITHER, so both
		// keep their own dots — same videoId alone never cedes a cluster.
		await expect(page.locator('#lockup-thumb .ytb-thumb-dots')).toHaveCount(1);
		await expect(page.locator('#dup-anchor .ytb-thumb-dots')).toHaveCount(1);

		// Ownership (#174), covering half: sat over the lockup tile, the mirror
		// OWNS that video's cluster — the covered tile's own dots are REMOVED
		// (not merely buried), while the duplicate of the same videoId elsewhere
		// in the feed keeps its own.
		await page.evaluate(() => {
			const host = document.querySelector<HTMLElement>('#preview-host')!;
			const tile = document.querySelector('#lockup-thumb')!.getBoundingClientRect();
			host.style.left = `${tile.left - 74}px`;
			host.style.top = `${tile.top - 37}px`;
		});
		await nudgeUntil(page, () => expect(page.locator('#lockup-thumb .ytb-thumb-dots')).toHaveCount(0, { timeout: 700 }));
		await expect(previewCluster).toHaveCount(1);
		await expect(page.locator('#dup-anchor .ytb-thumb-dots')).toHaveCount(1);

		// The preview going away sweeps the mirror and hands the cluster back to
		// the tile.
		await page.evaluate(() => {
			document.querySelector<HTMLElement>('#preview-host')!.style.display = 'none';
		});
		await nudgeUntil(page, () => expect(previewCluster).toHaveCount(0, { timeout: 700 }));
		await nudgeUntil(page, () => expect(page.locator('#lockup-thumb .ytb-thumb-dots')).toHaveCount(1, { timeout: 700 }));

		// Recycle safety: a mutation pass over unchanged data must not rebuild
		// the cluster (the signature guard) — a probe property survives the nudge.
		await page.evaluate(() => {
			(document.querySelector('#lockup-thumb .ytb-thumb-dots') as HTMLElement & { __ytbProbe?: boolean }).__ytbProbe = true;
		});
		await page.evaluate(() => document.body.appendChild(document.createComment('nudge')));
		await page.waitForTimeout(400);
		expect(
			await page.evaluate(
				() => (document.querySelector('#lockup-thumb .ytb-thumb-dots') as HTMLElement & { __ytbProbe?: boolean }).__ytbProbe,
			),
		).toBe(true);

		// A Buddy Color re-assignment repaints the dots live — no rebuild, no
		// reload (the color write triggers shared.js's storage listener, which
		// rebroadcasts ytb:buddy-colors).
		await popup.evaluate(() => chrome.storage.local.set({ buddyColors: { roome2e: { 'buddy-1': '#e85d04', 'buddy-2': '#00a86b' } } }));
		await expect
			.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('#lockup-thumb .ytb-thumb-dot')!).backgroundColor))
			.toBe('rgb(0, 168, 107)');

		// Buddy Progress Visibility off removes every cluster, live; back on
		// restores them.
		await popup.evaluate(() => chrome.storage.local.set({ buddyProgressHidden: true }));
		await expect(clusters).toHaveCount(0);
		await popup.evaluate(() => chrome.storage.local.set({ buddyProgressHidden: false }));
		await nudgeUntil(page, () => expect(clusters).toHaveCount(4, { timeout: 700 }));

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// A watch fixture whose progress bar has real layout, so dot geometry (exact
// timestamp fractions, the float above the bar's top edge) is assertable in
// pixels.
const sizedBarFixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>YouTube sized-bar fixture</title></head>
  <body>
    <main id="movie_player" class="html5-video-player" style="position: relative; width: 400px; height: 300px; background: #000">
      <video style="width: 400px; height: 300px"></video>
      <div class="ytp-chrome-bottom" style="position: absolute; left: 0; right: 0; bottom: 0; height: 40px">
        <div class="ytp-progress-bar" style="position: relative; width: 400px; height: 6px; background: #444"></div>
        <div class="ytp-left-controls"></div>
      </div>
    </main>
  </body>
</html>`;

test('Note Dots float above the bar at their true timestamps and swallow hover from the player', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: sizedBarFixture }),
		);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		// The extension is up once notes.js injects its styles (its ytb:room-data
		// listener attaches in the same synchronous load), so the dispatch below
		// lands. The Add Note (+) button is Room-gated now (#194); this is Unpaired.
		await expect(page.locator('#ytb-notes-style')).toHaveCount(1);

		// Render two Note dots half a second apart. The content scripts run in an
		// isolated world, so a main-world `Object.defineProperty(video, 'duration',
		// ...)` is invisible to them — give the fixture <video> a real 40s media
		// source instead (native element state is shared across worlds) and wait
		// for its metadata. Count the hover events the page world sees on the bar
		// (the events YouTube's storyboard/time-pill logic runs on) in a dataset
		// slot both worlds can read. CustomEvent detail crosses worlds via
		// structured clone in Chromium, so dispatching the Room read the way
		// renderer.js rebroadcasts one works.
		await page.evaluate(async (wavDataUri) => {
			const video = document.querySelector('video') as HTMLVideoElement;
			const loaded = new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
			video.src = wavDataUri;
			await loaded;
			const bar = document.querySelector('.ytp-progress-bar') as HTMLElement;
			bar.dataset.hovers = '0';
			for (const type of ['mousemove', 'mouseover']) {
				bar.addEventListener(type, () => {
					bar.dataset.hovers = String(Number(bar.dataset.hovers) + 1);
				});
			}
			document.dispatchEvent(
				new CustomEvent('ytb:room-data', {
					detail: {
						myClientId: 'me-client',
						roomCode: 'silly-otters',
						notes: [
							{
								id: 'note-1',
								clientId: 'buddy-1',
								name: 'Sam',
								videoId: 'fixture-video',
								timestamp: 20,
								kind: 'text',
								body: 'great moment',
								createdAt: 1,
							},
							{
								id: 'note-2',
								clientId: 'buddy-2',
								name: 'Kim',
								videoId: 'fixture-video',
								timestamp: 20.5,
								kind: 'text',
								body: 'same moment',
								createdAt: 2,
							},
						],
						replies: [],
					},
				}),
			);
		}, silentWavDataUri(40));
		const dots = page.locator('.ytb-note-dot');
		await expect(dots).toHaveCount(2);

		// Each dot's center sits at its exact timestamp / duration fraction of the
		// bar — 0.5s apart (5px here) the two overlap instead of being pushed
		// apart — and every dot's box floats entirely above the bar's top edge.
		const geometry = await page.evaluate(() => {
			const barRect = (document.querySelector('.ytp-progress-bar') as HTMLElement).getBoundingClientRect();
			return [...document.querySelectorAll('.ytb-note-dot')].map((dot) => {
				const rect = dot.getBoundingClientRect();
				return {
					id: (dot as HTMLElement).dataset.ytbNoteId,
					fraction: (rect.left + rect.width / 2 - barRect.left) / barRect.width,
					clearsBar: rect.bottom <= barRect.top,
					width: rect.width,
				};
			});
		});
		const at = (id: string) => geometry.find((dot) => dot.id === id)!;
		expect(at('note-1').fraction).toBeCloseTo(20 / 40, 2);
		expect(at('note-2').fraction).toBeCloseTo(20.5 / 40, 2);
		expect(Math.abs(at('note-2').fraction - at('note-1').fraction) * 400).toBeLessThan(at('note-1').width);
		for (const dot of geometry) expect(dot.clearsBar).toBe(true);

		// Hovering a dot leaks nothing into the bar beneath it: the page world
		// sees no mousemove/mouseover, so YouTube would pop no storyboard
		// thumbnail and no time pill behind the Note Preview.
		await dots.first().hover();
		const hovers = () => page.evaluate(() => Number((document.querySelector('.ytp-progress-bar') as HTMLElement).dataset.hovers));
		expect(await hovers()).toBe(0);

		// Hovering the bar itself a few pixels away still reaches it.
		await page.locator('.ytp-progress-bar').hover({ position: { x: 40, y: 3 } });
		expect(await hovers()).toBeGreaterThan(0);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// A player with room ABOVE the bar (the band our dots and previews live in) and
// room to the RIGHT of it (a dot clamped to the bar's end still gets its whole
// preview measured inside the viewport).
const roomyBarFixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>YouTube roomy-bar fixture</title></head>
  <body style="margin: 0">
    <main id="movie_player" class="html5-video-player" style="position: relative; width: 900px; height: 400px; background: #000">
      <video style="width: 900px; height: 400px"></video>
      <div class="ytp-chrome-bottom" style="position: absolute; left: 0; right: 0; bottom: 0; height: 40px">
        <div class="ytp-progress-bar" style="position: relative; width: 400px; height: 6px; background: #444"></div>
        <div class="ytp-left-controls"></div>
      </div>
    </main>
  </body>
</html>`;

/** Push one Room read into the page, exactly as renderer.js rebroadcasts one. */
async function pushNotes(page: Page, notes: unknown[]) {
	await page.evaluate((payload) => {
		document.dispatchEvent(
			new CustomEvent('ytb:room-data', {
				detail: { myClientId: 'me-client', roomCode: 'silly-otters', notes: payload, replies: [] },
			}),
		);
	}, notes);
}

/** Give the fixture's <video> real, seekable media so notes.js sees a duration. */
async function loadMedia(page: Page, dataUri: string) {
	await page.evaluate(async (src) => {
		const video = document.querySelector('video') as HTMLVideoElement;
		const loaded = new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
		video.src = src;
		await loaded;
	}, dataUri);
}

test('the progress bar stays seekable directly beneath a Note Dot: every surface we own clears its top edge', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: sizedBarFixture }),
		);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		// The extension is up once notes.js injects its styles (its ytb:room-data
		// listener attaches in the same synchronous load), so the dispatch below
		// lands. The Add Note (+) button is Room-gated now (#194); this is Unpaired.
		await expect(page.locator('#ytb-notes-style')).toHaveCount(1);

		// Count the press/hover family the page world sees on the bar — the events
		// YouTube's own seek and storyboard logic run on.
		await page.evaluate(() => {
			const bar = document.querySelector('.ytp-progress-bar') as HTMLElement;
			for (const type of ['mousedown', 'mousemove', 'mouseup']) {
				bar.dataset[type] = '0';
				bar.addEventListener(type, () => {
					bar.dataset[type] = String(Number(bar.dataset[type]) + 1);
				});
			}
		});
		await loadMedia(page, silentWavDataUri(40));
		// One roomy dot at 10s (x = 100 on the 400px bar) and a co-timed pair at
		// 30s (x = 300), which cluster and fan.
		await pushNotes(page, [
			{ id: 'iso', clientId: 'buddy-1', name: 'Sam', videoId: 'fixture-video', timestamp: 10, kind: 'text', body: 'here', createdAt: 1 },
			{ id: 'co-a', clientId: 'buddy-1', name: 'Sam', videoId: 'fixture-video', timestamp: 30, kind: 'text', body: 'a', createdAt: 2 },
			{ id: 'co-b', clientId: 'buddy-2', name: 'Kim', videoId: 'fixture-video', timestamp: 30.2, kind: 'text', body: 'b', createdAt: 3 },
		]);
		await expect(page.locator('.ytb-note-dot')).toHaveCount(3);
		await expect(page.locator('.ytb-note-dot-roomy')).toHaveCount(1); // only the isolated dot earns the hit extender

		// Hit-test the bar under a dot: sweep its full 6px height across the dot's
		// whole 32px hit width (the Note Band's box, #173). Nothing of ours may
		// answer — elementFromPoint is the same hit test the browser runs to
		// route a press, and it skips our pointer-events:none layers exactly as
		// a real click would.
		const sweepUnder = (id: string) =>
			page.evaluate((noteId) => {
				const dot = document.querySelector(`[data-ytb-note-id="${noteId}"]`) as HTMLElement;
				const bar = (document.querySelector('.ytp-progress-bar') as HTMLElement).getBoundingClientRect();
				const box = dot.getBoundingClientRect();
				const cx = box.left + box.width / 2;
				const ours: string[] = [];
				for (const dx of [-15, -8, 0, 8, 15]) {
					for (const y of [bar.top + 0.5, bar.top + 3, bar.bottom - 0.5]) {
						const hit = document.elementFromPoint(cx + dx, y) as HTMLElement | null;
						if (hit?.closest('.ytb-note-dot, .ytb-dot-cluster, .ytb-note-preview')) {
							ours.push(`${noteId} @${dx},${(y - bar.top).toFixed(1)} -> ${hit.className}`);
						}
					}
				}
				return ours;
			}, id);

		expect(await sweepUnder('iso')).toEqual([]);
		expect(await sweepUnder('co-a')).toEqual([]);

		// ... and still nothing while the dot is hovered, when its Note Preview,
		// the preview's hover bridge, and (for a Cluster) the hover keeper are all
		// live. This is the state that used to blanket the bar.
		await page.locator('[data-ytb-note-id="iso"]').hover();
		await expect
			.poll(() => page.locator('[data-ytb-note-id="iso"] .ytb-note-preview').evaluate((el) => getComputedStyle(el).opacity))
			.toBe('1');
		expect(await sweepUnder('iso')).toEqual([]);

		// The co-timed pair overlaps at rest — one dot literally covers the other —
		// so drive the pointer to the Cluster instead of asking Playwright to hover
		// a covered element. Whichever member is on top takes the hover; the
		// Cluster fans, and the keeper holds the fan open across the gaps.
		const clusterAt = await page.evaluate(() => {
			const dot = document.querySelector('[data-ytb-note-id="co-a"]')!.getBoundingClientRect();
			return { x: dot.left + dot.width / 2, y: dot.top + dot.height / 2 };
		});
		await page.mouse.move(clusterAt.x, clusterAt.y);

		const centres = () =>
			page.evaluate(() => {
				const centre = (id: string) => {
					const r = document.querySelector(`[data-ytb-note-id="${id}"]`)!.getBoundingClientRect();
					return r.left + r.width / 2;
				};
				return Math.abs(centre('co-b') - centre('co-a'));
			});
		await expect.poll(centres).toBeGreaterThan(6); // fanned apart by more than a dot's own width

		expect(await sweepUnder('co-a')).toEqual([]);
		expect(await sweepUnder('co-b')).toEqual([]);

		// A fanned member is still reachable — the pointer never left the Cluster's
		// keeper, and the far dot answers the hit test at its fanned position.
		const reachable = await page.evaluate(() => {
			const b = document.querySelector('[data-ytb-note-id="co-b"]')!.getBoundingClientRect();
			const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) as HTMLElement | null;
			return hit?.dataset.ytbNoteId === 'co-b';
		});
		expect(reachable).toBe(true);

		// A real press-and-drag on the bar AT the isolated Note's exact timestamp
		// reaches the bar, and opens no Note.
		const barY = await page.evaluate(() => {
			const bar = (document.querySelector('.ytp-progress-bar') as HTMLElement).getBoundingClientRect();
			return bar.top + bar.height / 2;
		});
		const dotX = await page
			.locator('[data-ytb-note-id="iso"]')
			.evaluate((el) => el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2);
		await page.mouse.move(dotX, barY);
		await page.mouse.down();
		await page.mouse.move(dotX + 40, barY, { steps: 4 });
		await page.mouse.up();

		const seen = await page.evaluate(() => {
			const bar = document.querySelector('.ytp-progress-bar') as HTMLElement;
			return {
				down: Number(bar.dataset.mousedown),
				move: Number(bar.dataset.mousemove),
				up: Number(bar.dataset.mouseup),
				// Our storyboard suppression is scoped to the band above the bar, so
				// hovering the bar leaves YouTube's own tooltip alone.
				suppressed: document.querySelector('#movie_player')!.classList.contains('ytb-note-tooltip-suppressed'),
			};
		});
		expect(seen.down).toBeGreaterThan(0);
		expect(seen.move).toBeGreaterThan(0);
		expect(seen.up).toBeGreaterThan(0);
		expect(seen.suppressed).toBe(false);
		await expect(page.locator('#ytb-note-panel')).toHaveCount(0);

		// The band ABOVE the bar still belongs to the dot: a click 5px to the side
		// and about 13px above the bar sits inside the Note Band's 12x14 hit box
		// (#173), outside the painted glyph, and opens the Expanded Note.
		await page.mouse.click(dotX + 5, barY - 14);
		await expect(page.locator('#ytb-note-panel')).toBeVisible();

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// The sized bar plus YouTube's scrubber knob, rebuilt with the stacking the
// real player CSS assigns (measured live, #173): the grab pad
// .ytp-progress-bar-padding at z-index 28 and the knob's
// .ytp-scrubber-container at z-index 43 — above the Dot Cluster's old 41,
// which is exactly how the knob swallowed every click on a dot near the
// playhead. The knob carries YouTube's big-mode 20px disc and hover-time
// scale(1.67), whose upper arc reaches ~15px above the bar's top edge — well
// into the Note Band and over the dot's glyph. Its 90px left centres it on
// x = 100, the fixture Note's own timestamp. The player is tall enough that
// the Expanded Note keeps its RESTING anchor (a short player deliberately
// slides the panel down over the control bar instead).
const scrubberBarFixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>YouTube scrubber-bar fixture</title></head>
  <body style="margin: 0">
    <main id="movie_player" class="html5-video-player" style="position: relative; width: 400px; height: 500px; background: #000">
      <video style="width: 400px; height: 500px"></video>
      <div class="ytp-chrome-bottom" style="position: absolute; left: 0; right: 0; bottom: 0; height: 40px">
        <div class="ytp-progress-bar" style="position: relative; width: 400px; height: 6px; background: #444">
          <div class="ytp-progress-bar-padding" style="position: absolute; width: 100%; height: 16px; bottom: 0; z-index: 28"></div>
          <div class="ytp-scrubber-container" style="position: absolute; top: -8px; left: 90px; z-index: 43">
            <div class="ytp-scrubber-button" style="height: 20px; width: 20px; border-radius: 10px; background: #f00; transform: scale(1.67)"></div>
          </div>
        </div>
        <div class="ytp-left-controls"></div>
      </div>
    </main>
  </body>
</html>`;

test('a Note Dot outranks the scrubber knob inside the Note Band, and the knob keeps the bar', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: scrubberBarFixture }),
		);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		// The extension is up once notes.js injects its styles (its ytb:room-data
		// listener attaches in the same synchronous load), so the dispatch below
		// lands. The Add Note (+) button is Room-gated now (#194); this is Unpaired.
		await expect(page.locator('#ytb-notes-style')).toHaveCount(1);

		await page.evaluate(() => {
			const bar = document.querySelector('.ytp-progress-bar') as HTMLElement;
			for (const type of ['mousedown', 'mouseup']) {
				bar.dataset[type] = '0';
				bar.addEventListener(type, () => {
					bar.dataset[type] = String(Number(bar.dataset[type]) + 1);
				});
			}
		});
		await loadMedia(page, silentWavDataUri(40));
		// One Note at 10s: x = 100 on the 400px bar, dead on the parked knob.
		await pushNotes(page, [
			{ id: 'parked', clientId: 'buddy-1', name: 'Sam', videoId: 'fixture-video', timestamp: 10, kind: 'text', body: 'here', createdAt: 1 },
		]);
		await expect(page.locator('.ytb-note-dot')).toHaveCount(1);
		await expect(page.locator('.ytb-note-dot-roomy')).toHaveCount(1);

		// The collision is real in this fixture: the knob's disc covers the dot's
		// glyph centre — and yet the hit test resolves to the dot, by stacking
		// order, with the knob's pointer events untouched.
		const contested = await page.evaluate(() => {
			const dot = document.querySelector('[data-ytb-note-id="parked"]') as HTMLElement;
			const knob = (document.querySelector('.ytp-scrubber-button') as HTMLElement).getBoundingClientRect();
			const box = dot.getBoundingClientRect();
			const x = box.left + box.width / 2;
			const y = box.top + box.height / 2;
			const covered = x >= knob.left && x <= knob.right && y >= knob.top && y <= knob.bottom;
			const hit = document.elementFromPoint(x, y) as HTMLElement | null;
			return { covered, oursWins: hit === dot || dot.contains(hit), x, y };
		});
		expect(contested.covered).toBe(true); // the knob really is on top of the glyph here
		expect(contested.oursWins).toBe(true);

		// A real click on the glyph opens the Expanded Note — it does not seek:
		// the dot swallows the press, so the bar (and the knob bubbling through
		// it) sees nothing.
		await page.mouse.click(contested.x, contested.y);
		await expect(page.locator('#ytb-note-panel')).toBeVisible();
		const pressed = await page.evaluate(() => {
			const bar = document.querySelector('.ytp-progress-bar') as HTMLElement;
			return Number(bar.dataset.mousedown);
		});
		expect(pressed).toBe(0);

		// The panel's resting anchor is derived from the dot geometry (#173): its
		// bottom edge clears the lifted glyph by the Note Band's breathing room.
		// Polled: the panel scales in from the dot (origin below the card), so a
		// mid-entrance measure reads its bottom edge low.
		const clearance = () =>
			page.evaluate(() => {
				const panel = document.getElementById('ytb-note-panel')!.getBoundingClientRect();
				const dot = document.querySelector('[data-ytb-note-id="parked"]')!.getBoundingClientRect();
				return dot.top - panel.bottom;
			});
		await expect.poll(clearance).toBeGreaterThanOrEqual(7);

		// Only the knob's overlap INTO the band is conceded (#158): ON the bar,
		// at the very same x, the knob still answers the hit test — scrubbing is
		// never lost, a drag still starts from its body and from the bar.
		const onBar = await page.evaluate(() => {
			const bar = (document.querySelector('.ytp-progress-bar') as HTMLElement).getBoundingClientRect();
			const hit = document.elementFromPoint(100, bar.top + 3) as HTMLElement | null;
			return { knob: Boolean(hit?.closest('.ytp-scrubber-container')), ours: Boolean(hit?.closest('.ytb-dot-cluster')) };
		});
		expect(onBar.knob).toBe(true);
		expect(onBar.ours).toBe(false);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('the Note Preview widens for its corner timestamp: body and time never overlap', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: roomyBarFixture }),
		);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		// The extension is up once notes.js injects its styles (its ytb:room-data
		// listener attaches in the same synchronous load), so the dispatch below
		// lands. The Add Note (+) button is Room-gated now (#194); this is Unpaired.
		await expect(page.locator('#ytb-notes-style')).toHaveCount(1);
		await loadMedia(page, silentWavDataUri(40));

		// The timestamp is rendered from the Note, so a moment past the fixture's
		// duration (clamped onto the bar's end) is how we exercise a long
		// "@10:02:33" against the short "@0:07" — same card, same layout.
		const LONG = 36153; // 10:02:33
		const SHORT = 7; // 0:07
		const long100 = 'x'.repeat(100);
		const cases: { id: string; at: number; kind: string; body: string; spoiler?: boolean; content: string }[] = [
			{ id: 'short-time-short-body', at: SHORT, kind: 'text', body: 'x', content: '.ytb-preview-body' },
			{ id: 'long-time-short-body', at: LONG, kind: 'text', body: 'x', content: '.ytb-preview-body' },
			{ id: 'long-time-long-body', at: LONG, kind: 'text', body: long100, content: '.ytb-preview-body' },
			{ id: 'short-time-long-body', at: SHORT, kind: 'text', body: long100, content: '.ytb-preview-body' },
			{ id: 'long-time-reaction', at: LONG, kind: 'emoji', body: '\u{1F525}', content: '.ytb-preview-emoji' },
			{ id: 'long-time-spoiler', at: LONG, kind: 'text', body: 'secret', spoiler: true, content: '.ytb-preview-spoiler' },
		];

		for (const kase of cases) {
			// One Note at a time: each dot is alone on the bar, so it is measured at
			// its natural hover size with no Cluster fan in play.
			await pushNotes(page, [
				{
					id: kase.id,
					clientId: 'buddy-1',
					name: 'Sam',
					videoId: 'fixture-video',
					timestamp: kase.at,
					kind: kase.kind,
					body: kase.body,
					spoiler: Boolean(kase.spoiler),
					createdAt: 1,
				},
			]);
			const dot = page.locator(`[data-ytb-note-id="${kase.id}"]`);
			await nudgeUntil(page, () => expect(dot).toHaveCount(1, { timeout: 700 }));
			await dot.hover();
			const preview = dot.locator('.ytb-note-preview');
			await expect.poll(() => preview.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

			const measured = await page.evaluate(
				({ id, content }) => {
					const cardEl = document.querySelector(`[data-ytb-note-id="${id}"] .ytb-note-preview`)!;
					const time = document.querySelector(`[data-ytb-note-id="${id}"] .ytb-preview-time`)!;
					const body = document.querySelector(`[data-ytb-note-id="${id}"] ${content}`)!;
					const card = cardEl.getBoundingClientRect();
					const cs = getComputedStyle(cardEl);
					const px = (v: string) => parseFloat(v) || 0;
					const insetTop = px(cs.borderTopWidth) + px(cs.paddingTop);
					const insetRight = px(cs.borderRightWidth) + px(cs.paddingRight);
					const insetLeft = px(cs.borderLeftWidth) + px(cs.paddingLeft);
					const t = time.getBoundingClientRect();
					const b = body.getBoundingClientRect();
					const overlapX = Math.max(0, Math.min(t.right, b.right) - Math.max(t.left, b.left));
					const overlapY = Math.max(0, Math.min(t.bottom, b.bottom) - Math.max(t.top, b.top));
					return {
						label: time.textContent,
						intersection: overlapX * overlapY,
						contentWidth: card.width - insetLeft - insetRight,
						bodyHeight: b.height,
						// Pinned to the card's top-right content corner.
						cornerTop: t.top - card.top - insetTop,
						cornerRight: card.right - insetRight - t.right,
						timeInsideCard: t.left >= card.left - 0.5 && t.right <= card.right + 0.5,
					};
				},
				{ id: kase.id, content: kase.content },
			);

			expect(measured.label, kase.id).toBe(kase.at === LONG ? '@10:02:33' : '@0:07');
			// The one invariant this slice buys: the timestamp reserves real width,
			// so nothing ever renders under it.
			expect(measured.intersection, kase.id).toBe(0);
			expect(measured.timeInsideCard, kase.id).toBe(true);
			expect(measured.cornerTop, kase.id).toBeCloseTo(0, 0);
			expect(measured.cornerRight, kase.id).toBeCloseTo(0, 0);
			// The card still honours its 240px cap, and a long body still clamps to
			// two lines (13px/1.4 => ~18.2px a line) instead of growing the card.
			expect(measured.contentWidth, kase.id).toBeLessThanOrEqual(240.5);
			if (kase.body === long100) expect(measured.bodyHeight, kase.id).toBeLessThan(40);
		}

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// The YouTube HOME page, reduced to what the Room Home surfaces target: the
// left guide (where home-toggle.js appends the Room Home Toggle row) and the
// home browse grid (above which home-section.js injects the Room Home
// Section).
const homeFixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>YouTube home fixture</title></head>
  <body>
    <div id="guide">
      <ytd-guide-renderer>
        <div id="sections">
          <ytd-guide-section-renderer><div id="items"></div></ytd-guide-section-renderer>
        </div>
      </ytd-guide-renderer>
    </div>
    <ytd-browse page-subtype="home">
      <div id="grid-container"><ytd-rich-grid-renderer></ytd-rich-grid-renderer></div>
    </ytd-browse>
  </body>
</html>`;

test('Room Home Toggle and the header close control both hide the Room Home Section, persisting across reload and SPA nav', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');

		// content.js only re-emits ytb:mutation on DOM churn; a static fixture
		// needs nudging for URL-change detection and injection retries.
		const nudge = () => page.evaluate(() => document.body.appendChild(document.createComment('nudge')));

		// Default: toggle on (checked) inside the guide, section rendered. The
		// row is a native-looking guide entry — icon + label, no switch cluster
		// — whose buddies icon is the only ON/OFF signal: apricot while the
		// section is shown.
		const toggle = page.locator('#ytb-home-toggle');
		const icon = toggle.locator('.ytb-ht-icon');
		const section = page.locator('#ytb-home-section');
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('ytd-guide-renderer #items #ytb-home-toggle')).toHaveCount(1);
		await expect(toggle.locator('.ytb-ht-track')).toHaveCount(0);
		await expect(icon).toHaveCSS('color', 'rgb(199, 113, 47)');
		await expect(section).toHaveCount(1);

		// Off: the section is removed completely, and mutation churn must not
		// re-inject it; the toggle row itself stays available in the guide,
		// its icon back at the native guide color (light-theme fixture).
		await toggle.click();
		await expect(section).toHaveCount(0);
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await expect(icon).toHaveCSS('color', 'rgb(15, 15, 15)');
		await nudge();
		await page.waitForTimeout(600);
		await expect(section).toHaveCount(0);
		await expect(toggle).toBeVisible();

		// The choice persists across a full reload.
		await page.reload();
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await page.waitForTimeout(600);
		await expect(section).toHaveCount(0);

		// ...and across SPA navigations: away from home the row disappears (the
		// section is off-route anyway); back on home both gates still hold.
		await page.evaluate(() => history.pushState({}, '', '/watch?v=fixture-video'));
		await nudge();
		await expect(toggle).toHaveCount(0);
		await page.evaluate(() => history.pushState({}, '', '/'));
		await nudge();
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await expect(section).toHaveCount(0);

		// Back on: the section re-injects right away.
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(section).toHaveCount(1);

		// The section header's own close control writes the SAME preference: the
		// section goes away completely, the guide row follows live (over
		// storage.onChanged) and stays available as the way back, and mutation
		// churn must not re-inject the section.
		await section.locator('.ytb-hs-close').click();
		await expect(section).toHaveCount(0);
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await expect(icon).toHaveCSS('color', 'rgb(15, 15, 15)');
		await nudge();
		await page.waitForTimeout(600);
		await expect(section).toHaveCount(0);

		// It persists like any other flip, and the guide row restores it.
		await page.reload();
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await page.waitForTimeout(600);
		await expect(section).toHaveCount(0);
		await toggle.click();
		await expect(section).toHaveCount(1);
		await expect(section.locator('.ytb-hs-close')).toBeVisible();

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('Control Panel Launcher opens the real action popup through a home-only Relay Frame', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		const extensions = await context.newPage();
		const extensionId = await (await extensionItem(extensions)).getAttribute('id');
		expect(extensionId).toMatch(/^[a-p]{32}$/);

		// A directly navigated extension page gives the test access to the runtime
		// API without itself being a Chrome-owned POPUP context.
		const runtime = await context.newPage();
		await runtime.goto(`chrome-extension://${extensionId}/popup.html`);
		const popupContextCount = () => runtime.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length);
		await expect.poll(popupContextCount).toBe(0);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		const toggle = page.locator('#ytb-home-toggle');
		const launcher = toggle.locator('.ytb-ht-launcher');
		const relay = page.locator('#ytb-control-panel-relay');
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(launcher).toBeVisible();
		await expect(relay).toHaveAttribute('src', `chrome-extension://${extensionId}/control-panel-relay.html`);
		expect(
			await relay.evaluate((frame) => {
				const rect = frame.getBoundingClientRect();
				return { width: rect.width, height: rect.height, visibility: getComputedStyle(frame).visibility };
			}),
		).toEqual({ width: 0, height: 0, visibility: 'hidden' });

		await launcher.click();
		await expect.poll(popupContextCount, { timeout: 10_000 }).toBe(1);
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('#ytb-panel-overlay, .ytb-panel-card, .ytb-panel-close')).toHaveCount(0);

		// The row and Relay Frame are one home-route surface and leave together.
		await page.evaluate(() => history.pushState({}, '', '/watch?v=fixture-video'));
		await page.evaluate(() => document.body.appendChild(document.createComment('nudge')));
		await expect(toggle).toHaveCount(0);
		await expect(relay).toHaveCount(0);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('Control Panel Launcher uses the shared toolbar toast when openPopup fails', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		const toggle = page.locator('#ytb-home-toggle');
		const launcher = toggle.locator('.ytb-ht-launcher');
		await expect(page.locator('#ytb-control-panel-relay')).toHaveCount(1);
		const relay = page.frames().find((frame) => frame.url().endsWith('/control-panel-relay.html'));
		expect(relay).toBeDefined();
		await relay!.evaluate(() => {
			Object.defineProperty(chrome.action, 'openPopup', {
				configurable: true,
				value: async () => {
					throw new Error('forced openPopup failure');
				},
			});
		});

		await launcher.click();
		await expect(page.locator('.ytb-toast')).toHaveText('Open YouTube Buddy from the toolbar icon');
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('#ytb-panel-overlay')).toHaveCount(0);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('opens the extension popup without runtime errors', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		const extensions = await context.newPage();
		const item = await extensionItem(extensions);
		const extensionId = await item.getAttribute('id');
		expect(extensionId).toMatch(/^[a-p]{32}$/);

		const popup = await context.newPage();
		await popup.goto(`chrome-extension://${extensionId}/popup.html`);
		await expect(popup.locator('h1')).toContainText('YouTube Buddy');
		await expect(popup.locator('.brand-mark')).toBeVisible();
		expect(
			await popup.locator('.brand-mark').evaluate((image: HTMLImageElement) => ({
				width: image.naturalWidth,
				height: image.naturalHeight,
			})),
		).toEqual({ width: 128, height: 128 });
		expect(
			await popup.evaluate(() => {
				const manifest = chrome.runtime.getManifest();
				return { icons: manifest.icons, actionIcons: manifest.action?.default_icon };
			}),
		).toEqual({
			icons: {
				16: 'icons/icon-16.png',
				32: 'icons/icon-32.png',
				48: 'icons/icon-48.png',
				128: 'icons/icon-128.png',
			},
			actionIcons: {
				16: 'icons/icon-16.png',
				32: 'icons/icon-32.png',
				48: 'icons/icon-48.png',
				128: 'icons/icon-128.png',
			},
		});
		await expect(popup.locator('#choose-create')).toBeVisible();
		await popup.waitForTimeout(250);
		await extensions.reload();
		await expect((await extensionItem(extensions)).locator('#errors-button')).toHaveCount(0);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('popup retains its roster through Connection Lost and recovers on the next successful read', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);
	let backendUp = true;

	try {
		await context.route('http://localhost:8787/**', (route) => {
			if (route.request().method() !== 'GET') {
				return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
			}
			if (!backendUp) return route.abort('connectionrefused');
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					progress: [],
					presence: [{ clientId: 'buddy-1', name: 'Bob', updatedAt: Date.now() }],
					notes: [],
					replies: [],
					playlist: [],
					events: [],
				}),
			});
		});

		const popup = await seedPairedRoom(context);
		await popup.reload();
		await expect(popup.locator('#status-text')).toHaveText('Buddies');
		await expect(popup.locator('.buddy-name')).toHaveText('Bob');

		backendUp = false;
		await popup.evaluate(() => (window as any).refreshStatus('roome2e'));
		await expect(popup.locator('#status-text')).toHaveText('Connecting to Room');
		await expect(popup.locator('.buddy-name')).toHaveText('Bob');
		await popup.evaluate(() => (window as any).refreshStatus('roome2e'));
		await expect(popup.locator('#status-text')).toHaveText("Can't reach the backend");
		await expect(popup.locator('#status-sub')).toHaveText('Retrying...');
		await expect(popup.locator('.buddy-name')).toHaveText('Bob');
		expect(errors).toHaveLength(2);
		expect(errors.every((error) => error.includes('ERR_CONNECTION_REFUSED'))).toBe(true);
		errors.length = 0;

		backendUp = true;
		await popup.evaluate(() => (window as any).refreshStatus('roome2e'));
		await expect(popup.locator('#status-text')).toHaveText('Buddies');
		await expect(popup.locator('.buddy-name')).toHaveText('Bob');
		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('Video Timeline retains its markers through Connection Lost and clears connectionLost on recovery', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);
	let backendUp = true;

	try {
		await context.route('http://localhost:8787/**', (route) => {
			const request = route.request();
			if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
			if (request.method() !== 'GET') {
				return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: true }) });
			}
			if (!backendUp) return route.abort('connectionrefused');
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				headers: CORS,
				body: JSON.stringify({
					progress: [{ clientId: 'buddy-1', name: 'Bob', videoId: 'fixture-video', timestamp: 30, duration: 100, updatedAt: Date.now() }],
					presence: [],
					notes: [],
					replies: [],
					playlist: [],
					events: [],
				}),
			});
		});
		await context.route('https://www.youtube.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));

		const popup = await seedPairedRoom(context);
		await popup.close(); // its own polling must not muddy the error ledger below

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');

		// Record the flags of every ytb:room-data broadcast from here on (the
		// initial on-load read may predate this listener; the test drives its own
		// reads below via yt-navigate-finish, exactly what YouTube's SPA fires).
		await page.evaluate(() => {
			(window as any).__broadcasts = [];
			document.addEventListener('ytb:room-data', (e) => {
				const d = (e as CustomEvent).detail || {};
				(window as any).__broadcasts.push({ ok: d.ok, connectionLost: d.connectionLost });
			});
		});
		const broadcasts = () => page.evaluate(() => (window as any).__broadcasts as { ok: boolean; connectionLost: boolean }[]);
		const driveRead = () => page.evaluate(() => document.dispatchEvent(new Event('yt-navigate-finish')));

		// A successful read draws Bob's marker at 30/100 through the bar's chapter
		// geometry (#159). This fixture bar is unchaptered — one segment — so that
		// is exactly 30% of its measured width, written in px.
		const marker = page.locator('.ytb-watch-marker');
		await nudgeUntil(page, async () => {
			await expect(marker).toHaveCount(1);
		});
		const barWidth = await page.locator('.ytp-progress-bar').evaluate((el) => el.getBoundingClientRect().width);
		expect(barWidth).toBeGreaterThan(0); // a zero-width bar would make every assertion below vacuous
		const markerLeft = () => marker.evaluate((el) => parseFloat((el as HTMLElement).style.left));
		await expect.poll(markerLeft).toBeCloseTo(0.3 * barWidth, 1);
		await driveRead();
		await expect.poll(async () => (await broadcasts()).filter((b) => b.ok).length).toBeGreaterThanOrEqual(1);
		expect((await broadcasts()).at(-1)).toEqual({ ok: true, connectionLost: false });

		// Two consecutive failed reads: the marker is retained as last seen (no
		// blanking, no on-video indicator), and connectionLost turns true only on
		// the second failure (the shared two-failure threshold).
		backendUp = false;
		await driveRead();
		await expect.poll(async () => (await broadcasts()).filter((b) => !b.ok).length).toBe(1);
		expect((await broadcasts()).at(-1)).toEqual({ ok: false, connectionLost: false });
		await expect(marker).toHaveCount(1);
		expect(await markerLeft()).toBeCloseTo(0.3 * barWidth, 1);

		await driveRead();
		await expect.poll(async () => (await broadcasts()).filter((b) => !b.ok).length).toBe(2);
		expect((await broadcasts()).at(-1)).toEqual({ ok: false, connectionLost: true });
		await expect(marker).toHaveCount(1);
		expect(await markerLeft()).toBeCloseTo(0.3 * barWidth, 1);

		// Only the aborted GETs may have errored; nothing else.
		expect(
			errors.every((error) => error.includes('ERR_CONNECTION_REFUSED')),
			errors.join('\n'),
		).toBe(true);
		errors.length = 0;

		// Recovery: the first successful read rebuilds the marker and clears
		// connectionLost on that same broadcast.
		backendUp = true;
		await driveRead();
		await expect.poll(async () => (await broadcasts()).at(-1)).toEqual({ ok: true, connectionLost: false });
		await expect(marker).toHaveCount(1);
		expect(await markerLeft()).toBeCloseTo(0.3 * barWidth, 1);
		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('Room Home Section keeps its Feed and Recommendations through Connection Lost and shows the retrying line', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);
	let backendUp = false; // unreachable from the start: the Unpaired phase below must not care

	try {
		await context.route('http://localhost:8787/**', (route) => {
			const request = route.request();
			if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
			if (request.method() !== 'GET') {
				return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: true }) });
			}
			if (!backendUp) return route.abort('connectionrefused');
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				headers: CORS,
				body: JSON.stringify({
					progress: [],
					presence: [],
					notes: [],
					replies: [],
					playlist: [{ videoId: 'vid-live', title: 'Buddy Pick', addedBy: 'buddy-1', addedByName: 'Sam', addedAt: 1000 }],
					events: [{ id: 'e1', type: 'added', videoId: 'vid-live', title: 'Buddy Pick', actorClientId: 'buddy-1', at: 1000 }],
				}),
			});
		});
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		// The grid card loads a real i.ytimg.com thumbnail URL; the fixture
		// videoId would 404 there and fail the console-error gate.
		const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
		await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: pixel }));

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');

		const section = page.locator('#ytb-home-section');
		const feedRow = section.locator('.ytb-hs-system');
		const card = section.locator('.ytb-hs-card');
		const conn = section.locator('.ytb-hs-conn');

		// Unpaired: the Create/Join prompt renders as normal with the backend
		// unreachable, and never shows a Connection Lost line — the flag only
		// applies once there is a Room Code.
		await nudgeUntil(page, async () => {
			await expect(section.locator('.ytb-hs-pair')).toHaveCount(1, { timeout: 700 });
		});
		await expect(conn).toHaveCount(0);
		expect(errors, errors.join('\n')).toEqual([]);

		const popup = await seedPairedRoom(context);
		await popup.close(); // its own polling must not muddy the error ledger below

		// Record the flags of every ytb:room-data broadcast from here on, so each
		// driven read below is awaited deterministically. `paired` separates real
		// Room reads from any straggling Unpaired broadcast (both carry ok=false).
		await page.evaluate(() => {
			(window as any).__broadcasts = [];
			document.addEventListener('ytb:room-data', (e) => {
				const d = (e as CustomEvent).detail || {};
				(window as any).__broadcasts.push({ ok: d.ok, connectionLost: d.connectionLost, paired: Boolean(d.roomCode) });
			});
		});
		const broadcasts = () =>
			page.evaluate(() => (window as any).__broadcasts as { ok: boolean; connectionLost: boolean; paired: boolean }[]);
		const driveRead = () => page.evaluate(() => document.dispatchEvent(new Event('yt-navigate-finish')));

		// A successful read renders the paired section: one System Message in the
		// Feed and one Recommendation card — and no Connection Lost line.
		backendUp = true;
		await driveRead();
		await nudgeUntil(page, async () => {
			await expect(feedRow).toHaveCount(1, { timeout: 700 });
		});
		await expect(feedRow).toContainText('Sam recommended Buddy Pick');
		await expect(card).toHaveCount(1);
		await expect(conn).toHaveCount(0);
		errors.length = 0; // seeding raced the down backend; only refusals can be here

		// First failed read: below the two-failure threshold — no line yet, and
		// the Feed and Recommendations are retained, not blanked.
		backendUp = false;
		await driveRead();
		await expect.poll(async () => (await broadcasts()).filter((b) => b.paired && !b.ok).length).toBe(1);
		await expect(conn).toHaveCount(0);
		await expect(feedRow).toHaveCount(1);
		await expect(card).toHaveCount(1);

		// The second failure trips Connection Lost: the quiet retrying line
		// appears while the retained content keeps rendering beneath it.
		await driveRead();
		await expect.poll(async () => (await broadcasts()).filter((b) => b.paired && !b.ok).length).toBe(2);
		await expect(conn).toHaveText("Can't reach your Room. Retrying...");
		await expect(feedRow).toContainText('Sam recommended Buddy Pick');
		await expect(card).toHaveCount(1);

		// Only the aborted GETs may have errored; nothing else.
		expect(
			errors.every((error) => error.includes('ERR_CONNECTION_REFUSED')),
			errors.join('\n'),
		).toBe(true);
		errors.length = 0;

		// Recovery: the first successful read clears the line and rebuilds the
		// Feed and Recommendations as normal.
		backendUp = true;
		await driveRead();
		await expect.poll(async () => (await broadcasts()).at(-1)).toEqual({ ok: true, connectionLost: false, paired: true });
		await expect(conn).toHaveCount(0);
		await expect(feedRow).toContainText('Sam recommended Buddy Pick');
		await expect(card).toHaveCount(1);
		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// A playable fixture for dot-click behavior: the <video> carries a real silent
// WAV as a data: URI (fully buffered, so the whole duration is seekable and
// currentTime/play()/pause() behave like a real player — a route-fulfilled
// media URL stalls at HAVE_METADATA with an empty seekable range), and the
// progress bar has real dimensions so Note dots render and are clickable.
function playbackFixture(mediaSrc: string) {
	return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>YouTube playback fixture</title></head>
  <body>
    <main id="movie_player" class="html5-video-player">
      <video src="${mediaSrc}" preload="auto"></video>
      <div class="ytp-chrome-bottom">
        <div class="ytp-progress-bar" style="position: relative; width: 400px; height: 6px; background: #444"></div>
        <div class="ytp-left-controls"></div>
      </div>
    </main>
    <ytd-watch-metadata>
      <div id="actions"><div id="top-level-buttons-computed"></div></div>
    </ytd-watch-metadata>
  </body>
</html>`;
}

/** A silent 8-bit mono PCM WAV of the given duration (real, seekable media). */
function silentWav(seconds: number): Buffer {
	const sampleRate = 8000;
	const dataSize = sampleRate * seconds;
	const wav = Buffer.alloc(44 + dataSize, 0x80);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(36 + dataSize, 4);
	wav.write('WAVE', 8);
	wav.write('fmt ', 12);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20); // PCM
	wav.writeUInt16LE(1, 22); // mono
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate, 28); // byte rate
	wav.writeUInt16LE(1, 32); // block align
	wav.writeUInt16LE(8, 34); // bits per sample
	wav.write('data', 36);
	wav.writeUInt32LE(dataSize, 40);
	return wav;
}

// One Buddy-authored Note of each dot kind on a 20s video. Go here (the panel's
// only seek) targets 1s before the timestamp, so it lands at 3 for the text
// Note, 7 for the Reaction, and 15 for the Spoiler.
const roomNotes = [
	{
		id: 'n-text',
		clientId: 'buddy-1',
		name: 'Buddy',
		videoId: 'fixture-video',
		timestamp: 4,
		kind: 'text',
		body: 'hello',
		spoiler: false,
		createdAt: 1,
	},
	{
		id: 'n-react',
		clientId: 'buddy-1',
		name: 'Buddy',
		videoId: 'fixture-video',
		timestamp: 8,
		kind: 'emoji',
		body: '\u{1F525}',
		spoiler: false,
		createdAt: 2,
	},
	{
		id: 'n-spoiler',
		clientId: 'buddy-1',
		name: 'Buddy',
		videoId: 'fixture-video',
		timestamp: 16,
		kind: 'text',
		body: 'secret',
		spoiler: true,
		createdAt: 3,
	},
];

test('foreground write failures distinguish an unreachable backend from server rejections', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);
	let failure: 'network' | 'server' = 'network';
	const textNote = roomNotes[0];

	try {
		await context.route('http://localhost:8787/**', (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
			if (request.method() === 'GET') {
				const body =
					url.pathname === '/conversation'
						? { note: textNote, replies: [] }
						: { progress: [], presence: [], notes: [textNote], replies: [], playlist: [], events: [] };
				return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
			}

			const foreground = ['/notes', '/replies', '/playlist'].includes(url.pathname);
			if (!foreground) {
				return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: true }) });
			}
			if (failure === 'network') return route.abort('connectionrefused');
			const category = url.pathname === '/notes' ? 'room_full' : url.pathname === '/replies' ? 'reply_cap' : 'playlist_full';
			return route.fulfill({
				status: 409,
				contentType: 'application/json',
				headers: CORS,
				body: JSON.stringify({ error: category.replace('_', ' '), category }),
			});
		});
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);
		const popup = await seedPairedRoom(context);
		await popup.evaluate(() => chrome.storage.local.set({ sharing: true }));

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const networkCopy = "Can't reach the backend. Check your connection and try again.";
		const noteComposer = page.locator('#ytb-note-composer');
		const noteError = noteComposer.locator('.ytb-note-error');
		const panel = page.locator('#ytb-note-panel');
		const pill = page.locator('#ytb-playlist-add-button');

		await nudgeUntil(page, () => expect(page.locator('.ytb-note-dot-text')).toHaveCount(1, { timeout: 700 }));
		await expect(pill).toHaveText('Recommend to Buddies');

		// One failed attempt surfaces connectivity immediately on each explicit-write
		// surface. The draft stays in place for a direct retry.
		await page.locator('#ytb-note-button').click();
		await noteComposer.locator('textarea').fill('network note');
		await page.keyboard.press('Enter');
		await expect(noteError).toHaveText(networkCopy);

		await page.keyboard.press('Escape');
		await page.locator('.ytb-note-dot-text').click();
		await panel.locator('.ytb-panel-reply-input').fill('network reply');
		await page.keyboard.press('Enter');
		await expect(panel.locator('.ytb-panel-error')).toHaveText(networkCopy);

		await pill.click();
		// Optimistic pill: the label flips at once, then the failed write rolls it
		// back with the reason in the popover — never in the label itself.
		await expect(page.locator('#ytb-playlist-feedback')).toHaveText(networkCopy);
		await expect(pill).toHaveText('Recommend to Buddies');
		expect(errors).toHaveLength(3);
		expect(errors.every((error) => error.includes('ERR_CONNECTION_REFUSED'))).toBe(true);
		errors.length = 0;

		// Server rejections keep their existing category-specific copy; the network
		// sentence is never used merely because a write failed.
		failure = 'server';
		await page.keyboard.press('Escape');
		await page.locator('#ytb-note-button').click();
		await noteComposer.locator('textarea').fill('room-full note');
		await page.keyboard.press('Enter');
		await expect(noteError).toHaveText("This Room is full, so you can't post here.");

		await page.keyboard.press('Escape');
		await page.locator('.ytb-note-dot-text').click();
		await panel.locator('.ytb-panel-reply-input').fill('eleventh reply');
		await page.keyboard.press('Enter');
		await expect(panel.locator('.ytb-panel-error')).toHaveText('This note already has 10 replies.');

		await expect(pill).toHaveAttribute('data-ytb-state', 'idle', { timeout: 2500 });
		// Playwright reaches this click well inside the pill's 1s cooldown from the
		// network-phase click above; a swallowed click is by design, so wait it out.
		await page.waitForTimeout(1100);
		await pill.click();
		// The category copy goes to the popover; the reverted label never carries it.
		await expect(page.locator('#ytb-playlist-feedback')).toHaveText('Room list full');
		await expect(pill).toHaveText('Recommend to Buddies');
		expect(errors).toHaveLength(3);
		expect(errors.every((error) => error.includes('409 (Conflict)'))).toBe(true);
	} finally {
		await context.close();
	}
});

test('the Note Composer and Expanded Note hold the chrome only while hovered, never on focus alone', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, { notes: roomNotes });
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);
		const popup = await seedPairedRoom(context);
		await popup.evaluate(() => chrome.storage.local.set({ sharing: true }));

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0);
		});
		await nudgeUntil(page, () => expect(page.locator('.ytb-note-dot-text')).toHaveCount(1, { timeout: 700 }));

		// The Controls Hold's only observable feed is nudgePlayerControls: a
		// synthetic mousemove dispatched ON the player root (an immediate one on the
		// first acquire, then a ~1.5s ticker) for as long as a hold is held. Count
		// those player-targeted moves from the page's main world -- the content
		// script dispatches them on a node both worlds share. The test never moves
		// the real pointer inside a measurement window and drives hover via
		// dispatched enter/leave, so the only player mousemoves in a quiet window are
		// the ticker's. Hover-scoped means: zero feeds while the pointer is off the
		// surface (even while it holds keyboard focus), a feed the instant it is hovered.
		const TICK = 1700; // one 1.5s ticker interval, with margin, to catch a leaked hold
		await page.evaluate(() => {
			const player = document.querySelector('#movie_player, .html5-video-player') as HTMLElement;
			player.dataset.ytbFeeds = '0';
			document.addEventListener(
				'mousemove',
				(e) => {
					const target = e.target as Node;
					if (target === player || player.contains(target)) player.dataset.ytbFeeds = String(Number(player.dataset.ytbFeeds) + 1);
				},
				true,
			);
		});
		const feeds = () =>
			page.evaluate(() => Number((document.querySelector('#movie_player, .html5-video-player') as HTMLElement).dataset.ytbFeeds));
		const resetFeeds = () =>
			page.evaluate(() => ((document.querySelector('#movie_player, .html5-video-player') as HTMLElement).dataset.ytbFeeds = '0'));
		// Dispatch a bare pointer event onto a YTB surface: the hold binding listens
		// for enter/leave regardless of where the real pointer is, so this exercises
		// the hover scope without moving (and thus feeding) the player.
		const dispatch = (selector: string, type: 'mouseenter' | 'mouseleave' | 'click') =>
			page.evaluate(
				({ selector, type }) => document.querySelector(selector)!.dispatchEvent(new MouseEvent(type, { bubbles: type === 'click' })),
				{
					selector,
					type,
				},
			);

		// --- Note Composer ---
		await page.locator('#ytb-note-button').click();
		const composer = page.locator('#ytb-note-composer');
		await expect(composer).toBeVisible();
		// It auto-focuses its textarea on open: focus is present, and must NOT hold.
		expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');

		// Open + focused + unhovered: no hold, so the ticker never feeds the player.
		await resetFeeds();
		await page.waitForTimeout(TICK);
		expect(await feeds(), 'an open but unhovered composer (focused) must not hold the chrome').toBe(0);

		// A real pointer hover takes the hold: the first acquire feeds immediately.
		await resetFeeds();
		await dispatch('#ytb-note-composer', 'mouseenter');
		expect(await feeds(), 'hovering the composer keeps the chrome awake').toBeGreaterThan(0);

		// mouseleave releases it: no further feeds.
		await dispatch('#ytb-note-composer', 'mouseleave');
		await resetFeeds();
		await page.waitForTimeout(TICK);
		expect(await feeds(), 'leaving the composer hands the timer back').toBe(0);

		// Closing while still hovered must not leak the live hover hold.
		await dispatch('#ytb-note-composer', 'mouseenter');
		await page.keyboard.press('Escape');
		await expect(composer).toHaveCount(0);
		await resetFeeds();
		await page.waitForTimeout(TICK);
		expect(await feeds(), 'closing the composer releases any live hover hold').toBe(0);

		// --- Expanded Note ---
		// Dispatch the dot's click so no real pointer or focus lands on its Cluster
		// (whose own hover/focus hold would otherwise feed the ticker) -- this
		// isolates the panel's own hold.
		await dispatch('.ytb-note-dot-text', 'click');
		const panel = page.locator('#ytb-note-panel');
		await expect(panel).toBeVisible();

		// Open + focused (openPanel calls panel.focus()) + unhovered: no hold.
		await resetFeeds();
		await page.waitForTimeout(TICK);
		expect(await feeds(), 'an open but unhovered Expanded Note must not hold the chrome').toBe(0);

		await resetFeeds();
		await dispatch('#ytb-note-panel', 'mouseenter');
		expect(await feeds(), 'hovering the Expanded Note keeps the chrome awake').toBeGreaterThan(0);

		await dispatch('#ytb-note-panel', 'mouseleave');
		await resetFeeds();
		await page.waitForTimeout(TICK);
		expect(await feeds(), 'leaving the Expanded Note hands the timer back').toBe(0);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('every Note Dot opens its Expanded Note variant; the click never seeks or changes playback', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, { notes: roomNotes });
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);

		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const video = page.locator('video');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0 && v.seekable.length && v.seekable.end(0) >= v.duration - 0.5);
		});

		// The initial render can race the media metadata (dots need a finite
		// duration); nudge until the three dots reconcile.
		const dots = page.locator('.ytb-note-dot');
		await nudgeUntil(page, () => expect(dots).toHaveCount(3, { timeout: 700 }));
		await expect(page.locator('.ytb-note-dot-text')).toHaveCount(1);
		await expect(page.locator('.ytb-note-dot-reaction')).toHaveCount(1);
		await expect(page.locator('.ytb-note-dot-locked')).toHaveCount(1);

		const panel = page.locator('#ytb-note-panel');
		const state = () => video.evaluate((v: HTMLVideoElement) => ({ currentTime: v.currentTime, paused: v.paused }));
		const parkAt = (t: number) =>
			video.evaluate((v: HTMLVideoElement, at) => {
				v.pause();
				v.currentTime = at;
			}, t);

		// Reaction dot: opens the read-only Reaction panel — the large emoji with
		// its author and the corner timestamp, but no Reply composer or delete. The
		// click seeks nowhere and leaves the video paused where it sat.
		await parkAt(1);
		await page.locator('.ytb-note-dot-reaction').click();
		await expect(panel).toBeVisible();
		await expect(panel.locator('.ytb-panel-emoji')).toHaveText('\u{1F525}');
		await expect(panel.locator('.ytb-panel-time')).toHaveText('@0:08');
		await expect(panel.locator('.ytb-panel-reply-input')).toHaveCount(0);
		await expect(panel.locator('.ytb-panel-delete')).toHaveCount(0);
		let s = await state();
		expect(s.currentTime).toBeCloseTo(1, 1);
		expect(s.paused).toBe(true);
		await page.keyboard.press('Escape');
		await expect(panel).toHaveCount(0);

		// Locked Spoiler dot: opens the masked panel — a muted "Spoiler" body (no
		// real body text) with the corner timestamp, and no Replies, composer, or
		// delete. Again no seek, no play.
		await parkAt(1);
		await page.locator('.ytb-note-dot-locked').click();
		await expect(panel).toBeVisible();
		await expect(panel.locator('.ytb-panel-spoiler')).toHaveText('Spoiler');
		await expect(panel.locator('.ytb-panel-body')).toHaveCount(0);
		await expect(panel.locator('.ytb-panel-time')).toHaveText('@0:16');
		await expect(panel.locator('.ytb-panel-reply-input')).toHaveCount(0);
		await expect(panel.locator('.ytb-panel-delete')).toHaveCount(0);
		s = await state();
		expect(s.currentTime).toBeCloseTo(1, 1);
		expect(s.paused).toBe(true);
		await page.keyboard.press('Escape');
		await expect(panel).toHaveCount(0);

		// Text Note dot: opens the conversation panel with the corner timestamp,
		// still without seeking.
		await parkAt(1);
		await page.locator('.ytb-note-dot-text').click();
		await expect(panel).toBeVisible();
		await expect(panel.locator('.ytb-panel-body')).toContainText('hello');
		await expect(panel.locator('.ytb-panel-time')).toHaveText('@0:04');
		// Sharing is off (seedPairedRoom leaves it off), yet the Reply composer is
		// present with no "Turn on Sharing" message — Sharing no longer gates Reply
		// writing (#194); a Room is all it needs.
		await expect(panel.locator('.ytb-panel-reply-input')).toHaveCount(1);
		await expect(panel.locator('.ytb-panel-reply-note')).toHaveCount(0);
		s = await state();
		expect(s.currentTime).toBeCloseTo(1, 1);
		expect(s.paused).toBe(true);

		// Go here is labelled without the "@time" suffix (the moment lives in its
		// aria-label instead).
		const goHere = panel.locator('.ytb-panel-gohere');
		await expect(goHere).toHaveText('Go here');
		await expect(goHere).toHaveAttribute('aria-label', /before 0:04/);

		// Go here is the only seek: it jumps to ~1s before the Note (goHereTarget(4)
		// = 3) and resumes play; the play event then closes the panel.
		await goHere.click();
		await expect.poll(async () => (await state()).paused).toBe(false);
		s = await state();
		expect(s.currentTime).toBeGreaterThanOrEqual(2.7);
		expect(s.currentTime).toBeLessThan(4);
		await expect(panel).toHaveCount(0);

		// Go here is omitted when the paused playhead already sits within 2s of the
		// moment: parked at t=4 (the text Note's own timestamp) there is nowhere to go.
		await parkAt(4);
		await page.locator('.ytb-note-dot-text').click();
		await expect(panel).toBeVisible();
		await expect(panel.locator('.ytb-panel-gohere')).toHaveCount(0);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('an open Expanded Note or Note Composer takes the Picture Click as the single playback writer', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, { notes: roomNotes });
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);
		const popup = await seedPairedRoom(context);
		await popup.evaluate(() => chrome.storage.local.set({ sharing: true }));

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const video = page.locator('video');
		const panel = page.locator('#ytb-note-panel');
		const composer = page.locator('#ytb-note-composer');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0 && v.seekable.length && v.seekable.end(0) >= v.duration - 0.5);
		});
		await nudgeUntil(page, () => expect(page.locator('.ytb-note-dot')).toHaveCount(3, { timeout: 700 }));

		// Reproduce YouTube's delayed picture toggle in the page world. If YTB lets
		// a Picture Click through, this handler runs after YTB's play and pauses the
		// video a beat later. Player controls are deliberately excluded.
		await page.evaluate(() => {
			const player = document.querySelector('#movie_player') as HTMLElement;
			const video = player.querySelector('video') as HTMLVideoElement;
			document.body.dataset.nativePictureClicks = '0';
			player.addEventListener('click', (event) => {
				const target = event.target as Element;
				if (target.closest('.ytp-chrome-bottom')) return;
				document.body.dataset.nativePictureClicks = String(Number(document.body.dataset.nativePictureClicks) + 1);
				setTimeout(() => void (video.paused ? video.play() : video.pause()), 120);
			});

			const controls = player.querySelector('.ytp-left-controls') as HTMLElement;
			const toggle = document.createElement('button');
			toggle.id = 'fixture-player-toggle';
			toggle.textContent = 'Toggle';
			toggle.addEventListener('click', () => void (video.paused ? video.play() : video.pause()));
			const gear = document.createElement('button');
			gear.id = 'fixture-player-gear';
			gear.textContent = 'Gear';
			gear.addEventListener('click', () => {
				document.body.dataset.gearClicks = String(Number(document.body.dataset.gearClicks || 0) + 1);
			});
			controls.append(toggle, gear);

			const outside = document.createElement('button');
			outside.id = 'fixture-outside';
			outside.textContent = 'Outside';
			document.body.append(outside);
		});

		const isPaused = () => video.evaluate((v: HTMLVideoElement) => v.paused);
		const parkPaused = (at = 1) =>
			video.evaluate((v: HTMLVideoElement, time) => {
				v.pause();
				v.currentTime = time;
			}, at);
		const play = () => video.evaluate((v: HTMLVideoElement) => v.play());
		const clickPicture = () =>
			video.evaluate((v: HTMLVideoElement) =>
				v.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })),
			);
		const expectStaysPlaying = async () => {
			await expect.poll(isPaused).toBe(false);
			await page.waitForTimeout(250);
			expect(await isPaused()).toBe(false);
		};

		// A playing video's Pause Hold and an already-paused video both converge on
		// one result for every Expanded Note variant: close, play, and stay playing.
		await play();
		await page.locator('.ytb-note-dot-text').click();
		await expect(panel).toBeVisible();
		expect(await isPaused()).toBe(true);
		await clickPicture();
		await expect(panel).toHaveCount(0);
		await expectStaysPlaying();

		for (const selector of ['.ytb-note-dot-reaction', '.ytb-note-dot-locked']) {
			await parkPaused();
			await page.locator(selector).click();
			await expect(panel).toBeVisible();
			await clickPicture();
			await expect(panel).toHaveCount(0);
			await expectStaysPlaying();
		}

		// The Note Composer follows the same rule and still discards its draft.
		await play();
		await page.locator('#ytb-note-button').click();
		await expect(composer).toBeVisible();
		await composer.locator('textarea').fill('discard this draft');
		expect(await isPaused()).toBe(true);
		await clickPicture();
		await expect(composer).toHaveCount(0);
		await expectStaysPlaying();
		await parkPaused();
		await page.locator('#ytb-note-button').click();
		await expect(composer).toBeVisible();
		await expect(composer.locator('textarea')).toHaveValue('');
		await clickPicture();
		await expect(composer).toHaveCount(0);
		await expectStaysPlaying();

		// Player chrome closes the overlay without releasing its Pause Hold. The
		// clicked control alone decides playback; a passive Gear leaves it paused.
		await play();
		await page.locator('.ytb-note-dot-text').click();
		await page.locator('#fixture-player-gear').click();
		await expect(panel).toHaveCount(0);
		expect(await isPaused()).toBe(true);
		expect(await page.locator('body').getAttribute('data-gear-clicks')).toBe('1');
		await parkPaused();
		await page.locator('.ytb-note-dot-text').click();
		await page.locator('#fixture-player-toggle').click();
		await expect(panel).toHaveCount(0);
		await expect.poll(isPaused).toBe(false);

		// Off-player clicks retain Pause Hold semantics.
		await play();
		await page.locator('.ytb-note-dot-text').click();
		await page.locator('#fixture-outside').click();
		await expect(panel).toHaveCount(0);
		await expect.poll(isPaused).toBe(false);
		await parkPaused();
		await page.locator('.ytb-note-dot-text').click();
		await page.locator('#fixture-outside').click();
		await expect(panel).toHaveCount(0);
		expect(await isPaused()).toBe(true);

		// With no YTB overlay open, the simulated native picture toggle is untouched.
		await play();
		await clickPicture();
		await expect.poll(isPaused).toBe(true);
		expect(await page.locator('body').getAttribute('data-native-picture-clicks')).toBe('1');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('Expanded Note prose selects, while overlay-origin drags leave both overlays and playback unchanged', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, {
			notes: roomNotes,
			replies: [
				{
					id: 'r-selectable',
					noteId: 'n-text',
					clientId: 'buddy-1',
					name: 'Buddy',
					body: 'reply prose',
					createdAt: 2,
				},
			],
		});
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);
		const popup = await seedPairedRoom(context);
		await popup.evaluate(() => chrome.storage.local.set({ sharing: true }));

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const video = page.locator('video');
		const panel = page.locator('#ytb-note-panel');
		const composer = page.locator('#ytb-note-composer');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0 && v.seekable.length && v.seekable.end(0) >= v.duration - 0.5);
		});
		await nudgeUntil(page, () => expect(page.locator('.ytb-note-dot')).toHaveCount(3, { timeout: 700 }));

		await video.evaluate((v: HTMLVideoElement) => {
			v.pause();
			v.currentTime = 1;
		});
		await page.locator('.ytb-note-dot-text').click();
		await expect(panel).toBeVisible();

		const userSelect = (selector: string) => panel.locator(selector).evaluate((element) => getComputedStyle(element).userSelect);
		for (const selector of [
			'.ytb-panel-body',
			'.ytb-panel-author',
			'.ytb-panel-time',
			'.ytb-panel-posted',
			'.ytb-panel-reply-body',
			'.ytb-panel-reply-author',
			'.ytb-panel-reply-time',
		]) {
			expect(await userSelect(selector), selector).toBe('text');
		}
		expect(await userSelect('.ytb-panel-gohere')).toBe('none');

		// A double-click selects the Note body as normal prose.
		await panel.locator('.ytb-panel-body').dblclick({ position: { x: 10, y: 10 } });
		expect(await page.evaluate(() => getSelection()?.toString())).toBe('hello');

		// Drag from the Note body beyond the panel onto the Video Picture. The
		// resulting click belongs to the overlay's Press Origin: selection stays,
		// the panel stays open, and the paused video stays paused.
		const bodyBox = await panel.locator('.ytb-panel-body').boundingBox();
		const videoBox = await video.boundingBox();
		expect(bodyBox).not.toBeNull();
		expect(videoBox).not.toBeNull();
		await page.mouse.move(bodyBox!.x + 3, bodyBox!.y + bodyBox!.height / 2);
		await page.mouse.down();
		await page.mouse.move(videoBox!.x + 8, videoBox!.y + 8, { steps: 8 });
		await page.mouse.up();
		await expect(panel).toBeVisible();
		expect((await page.evaluate(() => getSelection()?.toString() || '')).length).toBeGreaterThan(0);
		expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

		await page.keyboard.press('Escape');
		await page.locator('.ytb-note-dot-locked').click();
		await expect(panel.locator('.ytb-panel-spoiler')).toHaveCSS('user-select', 'none');
		await page.keyboard.press('Escape');
		await page.locator('.ytb-note-dot-reaction').click();
		await expect(panel.locator('.ytb-panel-emoji')).toHaveCSS('user-select', 'none');
		await expect(panel.locator('.ytb-panel-emoji-author')).toHaveCSS('user-select', 'text');
		await page.keyboard.press('Escape');

		// The Note Composer consumes the same Press Origin rule. Selecting out of
		// its textarea neither discards the draft nor changes playback.
		await page.locator('#ytb-note-button').click();
		await expect(composer).toBeVisible();
		const textarea = composer.locator('textarea');
		await textarea.fill('select this draft');
		const textareaBox = await textarea.boundingBox();
		expect(textareaBox).not.toBeNull();
		await page.mouse.move(textareaBox!.x + textareaBox!.width - 8, textareaBox!.y + textareaBox!.height / 2);
		await page.mouse.down();
		await page.mouse.move(videoBox!.x + 8, videoBox!.y + 8, { steps: 8 });
		await page.mouse.up();
		await expect(composer).toBeVisible();
		await expect(textarea).toHaveValue('select this draft');
		const textareaSelection = await textarea.evaluate((element: HTMLTextAreaElement) => ({
			start: element.selectionStart,
			end: element.selectionEnd,
		}));
		expect(textareaSelection.end).toBeGreaterThan(textareaSelection.start);
		expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('an Unseen Mention pulses its Note Dot; hovering Acknowledges it and a reload keeps it clear', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		// One Buddy Note Mentioning the viewer (viewer-e2e, seeded below) and one
		// plain Buddy Note: only the Mention's dot may pulse (ADR-0010).
		await stubRoomBackend(context, {
			notes: [
				{
					id: 'n-mention',
					clientId: 'buddy-1',
					name: 'Buddy',
					videoId: 'fixture-video',
					timestamp: 4,
					kind: 'text',
					body: 'look at this',
					spoiler: false,
					mentions: ['viewer-e2e'],
					createdAt: 1,
				},
				{
					id: 'n-plain',
					clientId: 'buddy-1',
					name: 'Buddy',
					videoId: 'fixture-video',
					timestamp: 12,
					kind: 'text',
					body: 'no mention here',
					spoiler: false,
					createdAt: 2,
				},
			],
		});
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);

		const popup = await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');

		const mentionDot = page.locator('.ytb-note-dot[data-ytb-note-id="n-mention"]');
		const plainDot = page.locator('.ytb-note-dot[data-ytb-note-id="n-plain"]');
		await nudgeUntil(page, () => expect(page.locator('.ytb-note-dot')).toHaveCount(2, { timeout: 700 }));

		// The Mention's dot pulses (the seen set starts empty); the plain dot never does.
		await nudgeUntil(page, () => expect(mentionDot).toHaveClass(/ytb-note-dot-unseen/, { timeout: 700 }));
		await expect(plainDot).not.toHaveClass(/ytb-note-dot-unseen/);

		// Once the playhead is beyond both Notes, the plain dot desaturates live,
		// while the Unseen Mention remains full color so its pulse stays prominent.
		await page.locator('video').evaluate((video: HTMLVideoElement) => {
			video.currentTime = 15;
			video.dispatchEvent(new Event('timeupdate'));
		});
		await expect(plainDot).toHaveClass(/ytb-note-dot-passed/);
		await expect(plainDot).toHaveCSS('filter', 'saturate(0.4) opacity(0.55)');
		await expect(mentionDot).not.toHaveClass(/ytb-note-dot-passed/);
		await expect(mentionDot).toHaveCSS('filter', 'none');

		// Hovering the dot Acknowledges it: the pulse stops...
		await mentionDot.hover();
		await expect(mentionDot).not.toHaveClass(/ytb-note-dot-unseen/);
		// ...and, because the playhead already crossed it, passed paint takes over.
		await expect(mentionDot).toHaveClass(/ytb-note-dot-passed/);
		await expect(mentionDot).toHaveCSS('filter', 'saturate(0.4) opacity(0.55)');
		// ...and the seen state lands in Room-scoped chrome.storage.local, never on
		// the wire (the stub records every request; none may carry the seen ids).
		await expect
			.poll(async () => popup.evaluate(async () => (await chrome.storage.local.get('seenItems')).seenItems))
			.toEqual({ roome2e: ['n-mention'] });

		// Rewinding before both timestamps restores both dots to full color.
		await page.locator('video').evaluate((video: HTMLVideoElement) => {
			video.currentTime = 0;
			video.dispatchEvent(new Event('timeupdate'));
		});
		await expect(mentionDot).not.toHaveClass(/ytb-note-dot-passed/);
		await expect(plainDot).not.toHaveClass(/ytb-note-dot-passed/);
		await expect(mentionDot).toHaveCSS('filter', 'none');
		await expect(plainDot).toHaveCSS('filter', 'none');

		// A reload re-reads the Room and the persisted seen set: Acknowledged stays
		// silent, and nothing else has started pulsing.
		await page.reload();
		await nudgeUntil(page, () => expect(page.locator('.ytb-note-dot')).toHaveCount(2, { timeout: 700 }));
		await page.waitForTimeout(400); // give the async seen-state sync a beat to derive pulses
		await expect(mentionDot).not.toHaveClass(/ytb-note-dot-unseen/);
		await expect(plainDot).not.toHaveClass(/ytb-note-dot-unseen/);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('Playback Notifications anchor at each of the four Notification Position edges, live', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, { notes: roomNotes });
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);

		const popup = await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const video = page.locator('video');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0 && v.seekable.length && v.seekable.end(0) >= v.duration - 0.5);
		});
		await nudgeUntil(page, () => expect(page.locator('.ytb-note-dot')).toHaveCount(3, { timeout: 700 }));

		// Cross the t=4 text Note by ordinary forward playback: that is what
		// builds the alerts stack, which then persists for the rest of the test.
		await video.evaluate((v: HTMLVideoElement) => {
			v.currentTime = 3.5;
			return v.play();
		});
		await expect(page.locator('.ytb-alert-card')).toHaveCount(1);
		await video.evaluate((v: HTMLVideoElement) => v.pause());

		// Inline styles own placement AND the edge-driven main axis
		// (applyAlertsPosition): a row for top/bottom, a column for left/right.
		const anchor = () =>
			page.locator('#ytb-note-alerts').evaluate((node) => {
				const s = (node as HTMLElement).style;
				return {
					top: s.top,
					bottom: s.bottom,
					left: s.left,
					right: s.right,
					transform: s.transform,
					alignItems: s.alignItems,
					flexDirection: s.flexDirection,
					flexWrap: s.flexWrap,
				};
			});
		const setEdge = (edge: string) => popup.evaluate((e) => chrome.storage.local.set({ notificationPosition: e }), edge);

		// Default is bottom: horizontally centered, offset up from the bottom — a
		// wrapping horizontal row (wrap-reverse keeps new lines off the edge).
		let a = await anchor();
		expect(a.left).toBe('50%');
		expect(a.transform).toBe('translateX(-50%)');
		expect(a.top).toBe('');
		expect(a.right).toBe('');
		expect(a.alignItems).toBe('center');
		expect(a.bottom).toMatch(/^\d+(\.\d+)?px$/);
		expect(a.flexDirection).toBe('row');
		expect(a.flexWrap).toBe('wrap-reverse');

		// top: horizontally centered, offset down from the top — a wrapping row.
		await setEdge('top');
		await expect.poll(async () => (await anchor()).bottom).toBe('');
		a = await anchor();
		expect(a.left).toBe('50%');
		expect(a.transform).toBe('translateX(-50%)');
		expect(a.alignItems).toBe('center');
		expect(a.top).toMatch(/^\d+(\.\d+)?px$/);
		expect(a.flexDirection).toBe('row');
		expect(a.flexWrap).toBe('wrap');

		// left: vertically centered against the left edge — a column.
		await setEdge('left');
		await expect.poll(async () => (await anchor()).left).toBe('16px');
		a = await anchor();
		expect(a.top).toBe('50%');
		expect(a.transform).toBe('translateY(-50%)');
		expect(a.bottom).toBe('');
		expect(a.right).toBe('');
		expect(a.alignItems).toBe('flex-start');
		expect(a.flexDirection).toBe('column');
		expect(a.flexWrap).toBe('nowrap');

		// right: vertically centered against the right edge — a column.
		await setEdge('right');
		await expect.poll(async () => (await anchor()).right).toBe('16px');
		a = await anchor();
		expect(a.top).toBe('50%');
		expect(a.transform).toBe('translateY(-50%)');
		expect(a.bottom).toBe('');
		expect(a.left).toBe('');
		expect(a.alignItems).toBe('flex-end');
		expect(a.flexDirection).toBe('column');
		expect(a.flexWrap).toBe('nowrap');

		// A stale 8-zone value is not an edge: fall back to the bottom default row.
		await setEdge('top-right');
		await expect.poll(async () => (await anchor()).top).toBe('');
		a = await anchor();
		expect(a.left).toBe('50%');
		expect(a.transform).toBe('translateX(-50%)');
		expect(a.bottom).toMatch(/^\d+(\.\d+)?px$/);
		expect(a.flexDirection).toBe('row');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// Three text Notes clustered so one ordinary forward step crosses them together.
const clusteredTextNotes = ['alpha', 'beta', 'gamma'].map((body, i) => ({
	id: `n-${body}`,
	clientId: 'buddy-1',
	name: 'Buddy',
	videoId: 'fixture-video',
	timestamp: 4 + i * 0.05, // 4.00, 4.05, 4.10 — a single ~0.25s tick clears all three
	kind: 'text',
	body,
	spoiler: false,
	createdAt: i + 1,
}));

test('concurrent Playback Notifications drain on a ~100ms stagger, in timestamp order, sharing a row on the bottom edge', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, { notes: clusteredTextNotes });
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);

		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const video = page.locator('video');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0 && v.seekable.length && v.seekable.end(0) >= v.duration - 0.5);
		});
		await nudgeUntil(page, () => expect(page.locator('.ytb-note-dot')).toHaveCount(3, { timeout: 700 }));

		// Record each card's entrance moment + text as it is appended (before the
		// .show class, so this is the true entrance, not the transition).
		await page.evaluate(() => {
			const w = window as unknown as { __entries: { t: number; body: string | null }[] };
			w.__entries = [];
			const log = w.__entries;
			new MutationObserver((records) => {
				for (const rec of records)
					for (const node of rec.addedNodes)
						if (node instanceof HTMLElement && node.classList.contains('ytb-alert-card'))
							log.push({ t: performance.now(), body: node.querySelector('.ytb-alert-body')?.textContent ?? null });
			}).observe(document.body, { childList: true, subtree: true });
		});

		// One forward step from before the cluster crosses all three at once.
		await video.evaluate((v: HTMLVideoElement) => {
			v.currentTime = 3.9;
			return v.play();
		});
		// All three enter (none dropped, no concurrency cap); staggered entrance
		// means they coexist — the first is still on screen (4s life) as the third
		// arrives, which strict serialization would never allow.
		await expect(page.locator('.ytb-alert-card')).toHaveCount(3, { timeout: 3000 });
		await video.evaluate((v: HTMLVideoElement) => v.pause());

		const entries = await page.evaluate(() => (window as unknown as { __entries: { t: number; body: string }[] }).__entries);
		// Timestamp order (alpha < beta < gamma), regardless of Room read order.
		expect(entries.map((e) => e.body)).toEqual(['alpha', 'beta', 'gamma']);
		// Entrances are ~100ms apart, not simultaneous (70ms floor absorbs jitter).
		expect(entries[1].t - entries[0].t).toBeGreaterThanOrEqual(70);
		expect(entries[2].t - entries[1].t).toBeGreaterThanOrEqual(70);

		// On the bottom edge the three share one horizontal row (equal-ish top) and
		// sit in disjoint horizontal slots (no overlap), left-to-right in order.
		const rects = await page
			.locator('.ytb-alert-card')
			.evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, top: r.top })));
		const tops = rects.map((r) => r.top);
		expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
		const byLeft = [...rects].sort((p, q) => p.left - q.left);
		for (let i = 1; i < byLeft.length; i++) expect(byLeft[i].left).toBeGreaterThanOrEqual(byLeft[i - 1].right - 0.5);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('six concurrent Reaction bursts lay out in the row without overlapping (no modulo fan)', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		const bursts = Array.from({ length: 6 }, (_, i) => ({
			id: `n-burst-${i}`,
			clientId: 'buddy-1',
			name: 'Buddy',
			videoId: 'fixture-video',
			timestamp: 4 + i * 0.02, // 4.00..4.10 — one forward step crosses all six
			kind: 'emoji',
			body: '\u{1F525}',
			spoiler: false,
			createdAt: i + 1,
		}));
		await stubRoomBackend(context, { notes: bursts });
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);

		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const video = page.locator('video');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0 && v.seekable.length && v.seekable.end(0) >= v.duration - 0.5);
		});
		await nudgeUntil(page, () => expect(page.locator('.ytb-note-dot')).toHaveCount(6, { timeout: 700 }));

		await video.evaluate((v: HTMLVideoElement) => {
			v.currentTime = 3.9;
			return v.play();
		});
		// All six coexist (2s life, ~500ms total stagger): the old modulo fan wrapped
		// at five, dropping the sixth onto the first's slot.
		await expect(page.locator('.ytb-alert-burst')).toHaveCount(6, { timeout: 3000 });
		await video.evaluate((v: HTMLVideoElement) => v.pause());

		// The flex axis owns spacing now — no --ytb-fan custom property remains.
		const fan = await page
			.locator('.ytb-alert-burst')
			.first()
			.evaluate((n) => (n as HTMLElement).style.getPropertyValue('--ytb-fan'));
		expect(fan).toBe('');

		// Disjoint horizontal slots ⇒ no two bursts overlap (the vertical float
		// leaves x untouched, so equal-ish tops are not required).
		const rects = await page
			.locator('.ytb-alert-burst')
			.evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
		const byLeft = [...rects].sort((p, q) => p.left - q.left);
		for (let i = 1; i < byLeft.length; i++) expect(byLeft[i].left).toBeGreaterThanOrEqual(byLeft[i - 1].right - 0.5);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test("a Post Echo fires the author's own Playback Notification on posting — paused, exactly once, still crossable later", async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		const calls: string[] = [];
		await stubRoomBackend(context, {}, calls);
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);
		const popup = await seedPairedRoom(context);
		await popup.evaluate(() => chrome.storage.local.set({ sharing: false })); // Sharing off: it no longer gates Note posting (#194)

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const video = page.locator('video');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0 && v.seekable.length && v.seekable.end(0) >= v.duration - 0.5);
		});
		await expect(page.locator('#ytb-note-button')).toBeVisible();

		// Log every notification the moment it enters: cards expire after ~4s, so
		// counting live nodes could never prove a notification fired EXACTLY once.
		await page.evaluate(() => {
			const fired: string[] = [];
			(window as unknown as { ytbFired: string[] }).ytbFired = fired;
			new MutationObserver((records) => {
				for (const record of records) {
					for (const node of record.addedNodes) {
						if (!(node instanceof HTMLElement)) continue;
						if (node.classList.contains('ytb-alert-card')) fired.push(`card:${node.querySelector('.ytb-alert-body')?.textContent}`);
						if (node.classList.contains('ytb-alert-burst'))
							fired.push(`burst:${node.querySelector('.ytb-alert-burst-emoji')?.textContent}`);
					}
				}
			}).observe(document.body, { childList: true, subtree: true });
		});
		const fired = () => page.evaluate(() => (window as unknown as { ytbFired: string[] }).ytbFired);
		const postNote = async (body: string) => {
			await page.locator('#ytb-note-button').click();
			await page.locator('#ytb-note-composer textarea').fill(body);
			await page.keyboard.press('Enter');
			await expect(page.locator('#ytb-note-composer')).toHaveCount(0);
		};

		// 1. A text Note posted from a PAUSED player echoes immediately — the card
		//    a Buddy would get, byline "You", with no playback whatsoever.
		await video.evaluate((v: HTMLVideoElement) => {
			v.pause();
			v.currentTime = 4;
		});
		await postNote('echo me');
		const card = page.locator('.ytb-alert-card');
		await expect(card).toHaveCount(1);
		await expect(card.locator('.ytb-alert-body')).toHaveText('echo me');
		await expect(card.locator('.ytb-alert-author')).toHaveText('You');
		expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

		// The echoed card is a crossing card in every respect: clicking it opens
		// that Note's Expanded Note.
		await card.click();
		const panel = page.locator('#ytb-note-panel');
		await expect(panel).toHaveCount(1);
		await expect(panel).toContainText('echo me');
		await page.keyboard.press('Escape');
		await expect(panel).toHaveCount(0);

		// 2. A Reaction posted from a paused player echoes as the burst.
		await video.evaluate((v: HTMLVideoElement) => {
			v.pause();
			v.currentTime = 8;
		});
		await page.locator('#ytb-note-button').click();
		await page.locator('#ytb-note-composer .ytb-note-emoji').first().click();
		await expect(page.locator('#ytb-note-composer')).toHaveCount(0);
		await expect(page.locator('.ytb-alert-burst')).toHaveCount(1);
		expect(await fired()).toEqual(['card:echo me', `burst:${'\u{1F44D}'}`]);

		// 3. Posting WHILE PLAYING: the composer's lease pauses on open and resumes
		//    on close, so playback runs right through the Note's timestamp a beat
		//    later. The echo already fired, and the crossing window was rebased past
		//    it — so it notifies exactly once, not twice.
		await video.evaluate((v: HTMLVideoElement) => v.play());
		await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 9);
		await postNote('posted mid-playback');
		await expect(page.locator('.ytb-alert-card', { hasText: 'posted mid-playback' })).toHaveCount(1);
		const posted = JSON.parse(
			calls
				.filter((call) => call.startsWith('POST') && call.includes('/notes'))
				.pop()!
				.split(' ')
				.slice(2)
				.join(' '),
		);
		expect(posted.timestamp).toBeGreaterThan(9);

		// Playback resumed (the lease) and carries well past the Note's moment.
		expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
		await page.waitForFunction((ts) => (document.querySelector('video')?.currentTime ?? 0) > ts + 1.5, posted.timestamp as number);
		await video.evaluate((v: HTMLVideoElement) => v.pause());
		expect(await fired()).toEqual(['card:echo me', `burst:${'\u{1F44D}'}`, 'card:posted mid-playback']);

		// 4. Ordinary crossing behavior is otherwise untouched: rewind and replay
		//    across that same moment and it notifies again, like any other Note.
		await video.evaluate((v: HTMLVideoElement, ts) => {
			v.currentTime = ts - 0.5;
			return v.play();
		}, posted.timestamp as number);
		await expect.poll(fired).toEqual([
			'card:echo me',
			`burst:${'\u{1F44D}'}`,
			'card:posted mid-playback',
			'card:posted mid-playback', // the replay crossing — a second, LATER notification
		]);
		await video.evaluate((v: HTMLVideoElement) => v.pause());

		// 5. Notes Visibility off renders nothing, the echo included.
		await popup.evaluate(() => chrome.storage.local.set({ notesHidden: true }));
		await expect(page.locator('#ytb-note-button')).toHaveCount(0); // no + button: the guard's path is unreachable
		await page.evaluate(() =>
			document.dispatchEvent(
				new CustomEvent('ytb:note-posted', {
					detail: {
						note: {
							id: 'hidden-1',
							clientId: 'viewer-e2e',
							videoId: 'fixture-video',
							timestamp: 12,
							kind: 'text',
							body: 'never rendered',
							spoiler: false,
						},
					},
				}),
			),
		);
		await expect(page.locator('.ytb-alert-card')).toHaveCount(0);
		expect((await fired()).filter((entry) => entry.includes('never rendered'))).toEqual([]);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('Spoiler checkbox keyboard: Enter posts the draft once, Space stays native, Escape closes', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		const calls: string[] = [];
		await stubRoomBackend(context, {}, calls);
		// Registered after (so matched before) the generic stub: POST /notes
		// answers with the complete server record, like the real Worker.
		await context.route('http://localhost:8787/notes**', (route) => {
			const request = route.request();
			if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
			const body = request.postData() ?? '';
			calls.push(`${request.method()} ${request.url()} ${body}`);
			const note = { id: 'posted-1', createdAt: Date.now(), ...JSON.parse(body) };
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				headers: CORS,
				body: JSON.stringify({ ok: true, id: note.id, note }),
			});
		});
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);
		const popup = await seedPairedRoom(context);
		await popup.evaluate(() => chrome.storage.local.set({ sharing: false })); // Sharing off: it no longer gates Note posting (#194)

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await expect(page.locator('#ytb-note-button')).toBeVisible();

		// Stand in for YouTube's capture-phase player hotkeys (main world, like
		// the real page): Enter activates the focused element — exactly what used
		// to re-toggle the checkbox — and Space toggles play/pause.
		await page.evaluate(() => {
			document.addEventListener(
				'keydown',
				(event) => {
					if (event.key === 'Enter' && document.activeElement instanceof HTMLElement) document.activeElement.click();
					if (event.key === ' ') {
						const video = document.querySelector('video');
						if (video) void (video.paused ? video.play() : video.pause());
					}
				},
				true,
			);
		});

		const composer = page.locator('#ytb-note-composer');
		const textarea = composer.locator('textarea');
		const spoilerBox = composer.locator('input[type="checkbox"]');
		const notePosts = () => calls.filter((call) => call.startsWith('POST') && call.includes('/notes'));

		// Baseline unchanged: Enter in the textarea posts the draft and closes.
		await page.locator('#ytb-note-button').click();
		await expect(textarea).toBeFocused();
		await textarea.fill('from the textarea');
		await page.keyboard.press('Enter');
		await expect(composer).toHaveCount(0);
		expect(notePosts()).toHaveLength(1);
		expect(notePosts()[0]).toContain('"body":"from the textarea"');

		// Checkbox focused (Tab from the textarea; a mouse click focuses it the
		// same way): Enter posts the typed Note exactly once through the same
		// path and never re-toggles the checkbox — the posted record still says
		// spoiler: true (the seeded default).
		await page.locator('#ytb-note-button').click();
		await expect(textarea).toBeFocused();
		await textarea.fill('from the checkbox');
		await page.keyboard.press('Tab');
		await expect(spoilerBox).toBeFocused();
		await expect(spoilerBox).toBeChecked();
		await page.keyboard.press('Enter');
		await expect(composer).toHaveCount(0);
		expect(notePosts()).toHaveLength(2);
		expect(notePosts()[1]).toContain('"body":"from the checkbox"');
		expect(notePosts()[1]).toContain('"spoiler":true');

		// Empty draft: Enter on the focused checkbox is a no-op, like textarea
		// Enter — nothing posts and the composer stays open.
		await page.locator('#ytb-note-button').click();
		await expect(textarea).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(spoilerBox).toBeFocused();
		await page.keyboard.press('Enter');
		await page.waitForTimeout(400);
		await expect(composer).toBeVisible();
		expect(notePosts()).toHaveLength(2);

		// Space keeps its native checkbox toggle and never reaches YouTube: the
		// (paused) video does not start playing.
		await expect(spoilerBox).toBeChecked();
		await page.keyboard.press('Space');
		await expect(spoilerBox).not.toBeChecked();
		expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

		// Escape on the focused checkbox closes the composer and discards the
		// draft (guarded keys never reach the document-level Escape listener).
		await textarea.fill('discard me');
		await page.keyboard.press('Tab');
		await expect(spoilerBox).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(composer).toHaveCount(0);
		expect(notePosts()).toHaveLength(2);
		await page.locator('#ytb-note-button').click();
		await expect(textarea).toHaveValue('');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('clicking a Reaction or locked-Spoiler hover preview opens its Expanded Note, exactly like its dot', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, { notes: roomNotes });
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);
		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const video = page.locator('video');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0 && v.seekable.length && v.seekable.end(0) >= v.duration - 0.5);
		});
		await video.evaluate((v: HTMLVideoElement) => {
			v.pause();
			v.currentTime = 2;
		});

		const panel = page.locator('#ytb-note-panel');
		const state = () => video.evaluate((v: HTMLVideoElement) => ({ currentTime: v.currentTime, paused: v.paused }));

		// The locked-Spoiler preview masks the body as "Spoiler" and is itself
		// clickable; clicking anywhere on it — not the tiny dot — opens the masked
		// Expanded Note, without seeking or changing playback.
		const lockedDot = page.locator('.ytb-note-dot-locked');
		await nudgeUntil(page, () => expect(lockedDot).toHaveCount(1, { timeout: 700 }));
		const lockedPreview = page.locator('.ytb-note-dot-locked .ytb-note-preview');
		await lockedDot.hover();
		await expect(lockedPreview).toHaveText(/Spoiler/);
		await expect.poll(() => lockedPreview.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto');
		await lockedPreview.click();
		await expect(panel).toBeVisible();
		await expect(panel.locator('.ytb-panel-spoiler')).toHaveText('Spoiler');
		await expect(panel.locator('.ytb-panel-body')).toHaveCount(0);
		let s = await state();
		expect(s.currentTime).toBeCloseTo(2, 1);
		expect(s.paused).toBe(true);
		await page.keyboard.press('Escape');
		await expect(panel).toHaveCount(0);

		// The Reaction preview is now clickable too; clicking it opens the read-only
		// Reaction panel, again without seeking or changing playback.
		const reactionDot = page.locator('.ytb-note-dot-reaction');
		const reactionPreview = page.locator('.ytb-note-dot-reaction .ytb-note-preview');
		await reactionDot.hover();
		await expect.poll(() => reactionPreview.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto');
		await reactionPreview.click();
		await expect(panel).toBeVisible();
		await expect(panel.locator('.ytb-panel-emoji')).toHaveText('\u{1F525}');
		s = await state();
		expect(s.currentTime).toBeCloseTo(2, 1);
		expect(s.paused).toBe(true);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// A playable fixture that also carries YouTube's storyboard thumbnail
// (.ytp-tooltip) at a fixed spot above the scrubber, positioned to overlap
// where a Reaction hover preview renders — proving the preview no longer
// clips or drops its corner timestamp for the storyboard (a hovered dot
// swallows its hover events, so the real player never even shows one).
function storyboardFixture(mediaSrc: string) {
	return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>YouTube storyboard fixture</title></head>
  <body>
    <main id="movie_player" class="html5-video-player" style="position: relative; width: 400px; height: 300px; background: #000">
      <video src="${mediaSrc}" preload="auto" style="width: 400px; height: 300px"></video>
      <div class="ytp-chrome-bottom" style="position: absolute; left: 0; right: 0; bottom: 0; height: 40px">
        <div class="ytp-progress-bar" style="position: relative; width: 400px; height: 6px; background: #444"></div>
        <div class="ytp-left-controls"></div>
      </div>
      <div class="ytp-tooltip ytp-bottom" style="position: absolute; left: 120px; bottom: 120px; width: 160px; height: 110px; background: #333">
        <div class="ytp-tooltip-bg"></div>
      </div>
    </main>
  </body>
</html>`;
}

test('a hovered Reaction preview renders at natural height with its corner timestamp, storyboard or not', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, { notes: roomNotes });
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: storyboardFixture(mediaSrc) }),
		);
		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0);
		});

		const reactionDot = page.locator('.ytb-note-dot-reaction');
		await nudgeUntil(page, () => expect(reactionDot).toHaveCount(1, { timeout: 700 }));
		const tooltip = page.locator('.ytp-tooltip');
		await expect(tooltip).toHaveCSS('display', 'block');
		await reactionDot.hover();
		await expect(tooltip).toHaveCSS('display', 'none');

		const preview = page.locator('.ytb-note-dot-reaction .ytb-note-preview');
		await expect.poll(() => preview.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

		// Natural height: no live cap, the emoji fully inside the preview's box,
		// and the corner timestamp chip intact — even with the storyboard element
		// overlapping where the preview renders.
		const state = await page.evaluate(() => {
			const el = document.querySelector('.ytb-note-dot-reaction .ytb-note-preview') as HTMLElement;
			const pv = el.getBoundingClientRect();
			const em = document.querySelector('.ytb-note-dot-reaction .ytb-preview-emoji')!.getBoundingClientRect();
			return {
				uncapped: el.style.maxHeight === '' && getComputedStyle(el).maxHeight === 'none',
				emojiInside: em.height > 0 && em.top >= pv.top - 0.5 && em.bottom <= pv.bottom + 0.5,
				chipShown: getComputedStyle(document.querySelector('.ytb-note-dot-reaction .ytb-preview-time')!).display !== 'none',
			};
		});
		expect(state).toEqual({ uncapped: true, emojiInside: true, chipShown: true });

		// Leaving the Dot Cluster restores YouTube's storyboard for normal
		// scrubbing immediately.
		await page.locator('video').hover({ position: { x: 10, y: 10 } });
		await expect(tooltip).toHaveCSS('display', 'block');

		// The later Spoiler remains locked and full color before its timestamp.
		const lockedDot = page.locator('.ytb-note-dot-locked');
		await expect(lockedDot).toHaveCount(1);
		await expect(lockedDot).not.toHaveClass(/ytb-note-dot-passed/);
		await expect(lockedDot).toHaveCSS('filter', 'none');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// A watch page with the Like/Share/Save actions row, where playlist-add.js
// injects the "Recommend to Buddies" pill.
const watchActionsFixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>YouTube watch fixture</title></head>
  <body>
    <main id="movie_player" class="html5-video-player">
      <video></video>
      <div class="ytp-chrome-bottom">
        <div class="ytp-progress-bar"></div>
        <div class="ytp-left-controls"></div>
      </div>
    </main>
    <ytd-watch-metadata>
      <h1>Fixture Video</h1>
      <div id="actions"><div id="top-level-buttons-computed"></div></div>
    </ytd-watch-metadata>
  </body>
</html>`;

test('watch pill offers Unrecommend on an own Recommendation and un-recommends for everyone', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		const calls: string[] = [];
		await stubRoomBackend(
			context,
			{ playlist: [{ videoId: 'fixture-video', title: 'Fixture Video', addedBy: 'viewer-e2e', addedByName: 'Viewer', addedAt: 1000 }] },
			calls,
		);
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: watchActionsFixture }),
		);
		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');

		// The pill lands as "Recommend to Buddies" and flips to the "Unrecommend"
		// toggle state once the Room read shows this viewer recommended the video.
		const pill = page.locator('#ytb-playlist-add-button');
		await nudgeUntil(page, () => expect(pill).toHaveText('Unrecommend', { timeout: 700 }));

		// Clicking un-recommends: the label flips optimistically (before the wire
		// write), then exactly one DELETE /playlist goes out, attributed to the viewer.
		await pill.click();
		await expect(pill).toHaveText('Recommend to Buddies');
		await expect.poll(() => calls.filter((call) => call.startsWith('DELETE ')).length).toBe(1);
		const deletes = calls.filter((call) => call.startsWith('DELETE '));
		expect(deletes[0]).toContain('/playlist?code=roome2e&clientId=viewer-e2e&videoId=fixture-video');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('the Recommend pill is optimistic: flips before the write lands, absorbs the cooldown, coalesces a mid-flight toggle', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		const calls: string[] = [];
		let releaseAdd: (() => void) | null = null;
		let addSettled = false;
		await context.route('http://localhost:8787/**', async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			calls.push(`${request.method()} ${url.pathname}`);
			if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
			if (request.method() === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					headers: CORS,
					body: JSON.stringify({ progress: [], presence: [], notes: [], replies: [], playlist: [], events: [] }),
				});
			}
			if (request.method() === 'POST' && url.pathname === '/playlist') {
				// Hold the add open until the test releases it: everything the pill
				// does before then happens with the response still in flight.
				await new Promise<void>((resolve) => {
					releaseAdd = resolve;
				});
				addSettled = true;
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					headers: CORS,
					body: JSON.stringify({
						ok: true,
						item: { videoId: 'fixture-video', title: 'Fixture Video', addedBy: 'viewer-e2e', addedAt: 1000 },
					}),
				});
			}
			return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: true }) });
		});
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: watchActionsFixture }),
		);
		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const pill = page.locator('#ytb-playlist-add-button');
		await nudgeUntil(page, () => expect(pill).toHaveText('Recommend to Buddies', { timeout: 700 }));

		// The click flips the label immediately — the POST is still in flight —
		// with no "Recommending..." label and no disabled lockout.
		await pill.click();
		await expect(pill).toHaveText('Unrecommend');
		expect(addSettled).toBe(false);
		await expect(pill).not.toBeDisabled();

		// A second click inside the 1s cooldown is silently ignored: the label
		// holds, with no visual sign of the cooldown.
		await pill.click();
		await expect(pill).toHaveText('Unrecommend');
		await expect(pill).not.toBeDisabled();
		expect(await pill.evaluate((b) => getComputedStyle(b).opacity)).toBe('1');

		// Past the cooldown, a genuine toggle while the add is still in flight is
		// accepted — optimistically, again...
		await page.waitForTimeout(1100);
		await pill.click();
		await expect(pill).toHaveText('Recommend to Buddies');
		expect(addSettled).toBe(false);
		// ...but at most one write per video flies: still one POST, no DELETE yet.
		expect(calls.filter((c) => c.startsWith('POST /playlist'))).toHaveLength(1);
		expect(calls.filter((c) => c.startsWith('DELETE '))).toHaveLength(0);

		// Release the add: the moved intent goes out as a single delta DELETE and
		// the pill keeps the newest intent's state — the late response never wins.
		await expect.poll(() => releaseAdd !== null).toBe(true);
		releaseAdd!();
		await expect.poll(() => calls.filter((c) => c.startsWith('DELETE /playlist')).length).toBe(1);
		expect(calls.filter((c) => c.startsWith('POST /playlist'))).toHaveLength(1);
		await expect(pill).toHaveText('Recommend to Buddies');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('Recommended for you grid hides own items; Dismiss is local-only and survives reload', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		const calls: string[] = [];
		await stubRoomBackend(
			context,
			{
				playlist: [
					{ id: 'rec-own', videoId: 'vid-own', title: 'My Own Pick', addedBy: 'viewer-e2e', addedByName: 'Viewer', addedAt: 1000 },
					{ id: 'rec-keep', videoId: 'vid-keep', title: 'Buddy Keeper', addedBy: 'buddy-1', addedByName: 'Buddy', addedAt: 2000 },
					{ id: 'rec-dismiss', videoId: 'vid-dismiss', title: 'Buddy Dismissed', addedBy: 'buddy-1', addedByName: 'Buddy', addedAt: 3000 },
				],
			},
			calls,
		);
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		// The cards load real i.ytimg.com thumbnail URLs; the fixture videoIds
		// would 404 there and fail the console-error gate.
		const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
		await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: pixel }));
		const popup = await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');

		// The renamed section renders only the Buddies' Recommendations: the
		// viewer's own pick never appears in their own grid.
		const section = page.locator('#ytb-home-section');
		const cards = section.locator('.ytb-hs-card');
		await nudgeUntil(page, () => expect(cards).toHaveCount(2, { timeout: 700 }));
		await expect(section).toContainText('Recommended for you');
		await expect(section).not.toContainText('Shared Playlist');
		await expect(section).not.toContainText('My Own Pick');

		// Dismiss hides the card for this viewer immediately...
		await section.locator('.ytb-hs-card').filter({ hasText: 'Buddy Dismissed' }).locator('.ytb-hs-remove').click();
		await expect(cards).toHaveCount(1);
		await expect(section).not.toContainText('Buddy Dismissed');

		// ...persisted Room-scoped in chrome.storage.local (read via the popup,
		// which shares the extension's storage)...
		await expect
			.poll(async () => popup.evaluate(() => chrome.storage.local.get('dismissedRecommendations')))
			.toEqual({ dismissedRecommendations: { roome2e: ['rec-dismiss'] } });

		// ...so the video stays hidden across a full reload.
		await page.reload();
		await nudgeUntil(page, () => expect(cards).toHaveCount(1, { timeout: 700 }));
		await expect(section).toContainText('Buddy Keeper');
		await expect(section).not.toContainText('Buddy Dismissed');

		// A Dismiss never touches the Room's Recommendation on the backend: no
		// playlist write of any kind hit the wire.
		expect(calls.filter((call) => call.startsWith('DELETE ') || call.includes('/playlist'))).toEqual([]);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('recommend Feed lines: own "You recommended", recipient copy, title-only links, strikethrough on un-recommend', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		// A two-member Room read from the viewer's side: a Buddy's live
		// Recommendation, the viewer's own live Recommendation, a Buddy
		// recommend whose videoId has since left the live list (un-recommended;
		// removals emit NO event — ADR-0007), and one video recommended, then
		// un-recommended, then re-recommended — two `added` Events, the older
		// superseded (per-Event strike, issue #110). The Buddy also has a
		// Progress Record for the viewer's pick, producing a Watch Notice.
		await stubRoomBackend(context, {
			progress: [{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-own', timestamp: 30, duration: 100, updatedAt: 4000 }],
			playlist: [
				{ videoId: 'vid-live', title: 'Buddy Pick', addedBy: 'buddy-1', addedByName: 'Sam', addedAt: 1000 },
				{ videoId: 'vid-own', title: 'My Pick', addedBy: 'viewer-e2e', addedByName: 'Viewer', addedAt: 2000 },
				{ videoId: 'vid-re', title: 'Re Pick', addedBy: 'buddy-1', addedByName: 'Sam', addedAt: 5000 },
			],
			events: [
				{ id: 'e1', type: 'added', videoId: 'vid-live', title: 'Buddy Pick', actorClientId: 'buddy-1', at: 1000 },
				{ id: 'e2', type: 'added', videoId: 'vid-own', title: 'My Pick', actorClientId: 'viewer-e2e', at: 2000 },
				{ id: 'e3', type: 'added', videoId: 'vid-gone', title: 'Gone Pick', actorClientId: 'buddy-1', at: 3000 },
				{ id: 'e4', type: 'added', videoId: 'vid-re', title: 'Re Pick', actorClientId: 'buddy-1', at: 4000 },
				{ id: 'e5', type: 'added', videoId: 'vid-re', title: 'Re Pick', actorClientId: 'buddy-1', at: 5000 },
			],
		});
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		// The grid cards load real i.ytimg.com thumbnail URLs; the fixture
		// videoIds would 404 there and fail the console-error gate.
		const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
		await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: pixel }));
		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');

		// Five System Messages + one Watch Notice, all on the quiet system row.
		const rows = page.locator('#ytb-home-section .ytb-hs-system');
		await nudgeUntil(page, () => expect(rows).toHaveCount(6, { timeout: 700 }));

		// Recipient copy drops "you"; ONLY the title is a link, and it is unquoted.
		const recipient = rows.filter({ hasText: 'Sam recommended Buddy Pick' });
		await expect(recipient).toHaveCount(1);
		await expect(page.locator('#ytb-home-section')).not.toContainText('recommended you');
		await expect(recipient.locator('a')).toHaveCount(1);
		await expect(recipient.locator('a.ytb-hs-title-link')).toHaveText('Buddy Pick');
		await expect(recipient.locator('a.ytb-hs-title-link')).toHaveAttribute('href', '/watch?v=vid-live');
		await expect(recipient.locator('a.ytb-hs-title-link')).toHaveAttribute('title', 'Watch "Buddy Pick"');

		// The recommender now sees their own line, title-linked the same way.
		const own = rows.filter({ hasText: 'You recommended My Pick to the Room' });
		await expect(own).toHaveCount(1);
		await expect(own.locator('a.ytb-hs-title-link')).toHaveAttribute('href', '/watch?v=vid-own');

		// The un-recommended line renders struck through (its sentence span), the
		// live one does not.
		const decorationOf = (row: typeof recipient) =>
			row.evaluate((el) => getComputedStyle(el.querySelector('span') as Element).textDecorationLine);
		const struck = rows.filter({ hasText: 'Sam recommended Gone Pick' });
		await expect(struck).toHaveCount(1);
		expect(await decorationOf(struck)).toBe('line-through');
		expect(await decorationOf(recipient)).not.toBe('line-through');

		// A struck line is dead in the DOM too (issue #110): NO anchor at all —
		// the title is plain muted text — while the row explains itself with a
		// tooltip and a visually-hidden suffix for assistive tech.
		await expect(struck.locator('a')).toHaveCount(0);
		await expect(struck).toHaveAttribute('title', 'No longer recommended');
		await expect(struck.locator('.ytb-hs-sr')).toContainText('no longer recommended');

		// Per-Event strike (issue #110): recommend -> un-recommend -> re-recommend
		// yields TWO lines for one video — the superseded Event struck and
		// unlinked even though its videoId is live again, the newest Event live
		// and linked.
		const reRows = rows.filter({ hasText: 'Sam recommended Re Pick' });
		await expect(reRows).toHaveCount(2);
		const dead = reRows.filter({ hasText: 'no longer recommended' });
		await expect(dead).toHaveCount(1);
		expect(await decorationOf(dead)).toBe('line-through');
		await expect(dead.locator('a')).toHaveCount(0);
		const alive = reRows.filter({ hasNotText: 'no longer recommended' });
		await expect(alive).toHaveCount(1);
		expect(await decorationOf(alive)).not.toBe('line-through');
		await expect(alive.locator('a.ytb-hs-title-link')).toHaveAttribute('href', '/watch?v=vid-re');

		// The Watch Notice's title links to the video too.
		const watch = rows.filter({ hasText: 'Sam started watching My Pick' });
		await expect(watch).toHaveCount(1);
		await expect(watch.locator('a.ytb-hs-title-link')).toHaveAttribute('href', '/watch?v=vid-own');
		await expect(watch.locator('a.ytb-hs-title-link')).toHaveAttribute('title', 'Watch "My Pick"');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('Room Feed windows the newest 20 behind Show more; reveals and rebuilds keep the viewer in place', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		// 45 recommend events: Picks 01-30 yesterday noon, Picks 31-45 today noon
		// (noon anchors keep the day split deterministic whatever the wall clock),
		// so the initial 20-item window splits yesterday — the window is
		// item-level, and a partly revealed day keeps its divider.
		const todayNoon = new Date().setHours(12, 0, 0, 0);
		const calls: string[] = [];
		const events = Array.from({ length: 45 }, (_, i) => {
			const n = String(i + 1).padStart(2, '0');
			return {
				id: `e${n}`,
				type: 'added',
				videoId: `vid-${n}`,
				title: `Pick ${n}`,
				actorClientId: 'buddy-1',
				at: (i < 30 ? todayNoon - 24 * 3600_000 : todayNoon) + i * 60_000,
			};
		});
		await stubRoomBackend(context, { events }, calls);
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }),
		);
		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');

		// Only the newest 20 of 45 render — under both day dividers (yesterday
		// partly revealed) — with Show more sitting above the topmost divider and
		// the scrollback pinned to the newest item.
		const items = page.locator('#ytb-home-section .ytb-hs-item');
		const more = page.locator('#ytb-home-section .ytb-hs-more');
		await nudgeUntil(page, () => expect(items).toHaveCount(20, { timeout: 700 }));
		await expect(items.first()).toContainText('Pick 26'); // the oldest revealed
		await expect(page.locator('#ytb-home-section .ytb-hs-day')).toHaveCount(2);
		await expect(more).toHaveCount(1);
		expect(await more.evaluate((el) => el.nextElementSibling?.className)).toBe('ytb-hs-day');
		const scrollState = () =>
			page
				.locator('#ytb-home-section .ytb-hs-feed-scroll')
				.evaluate((el) => ({ top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop }));
		const pinned = await scrollState();
		expect(pinned.top).toBeGreaterThan(0);
		expect(pinned.gap).toBeLessThanOrEqual(8);

		// Reveal a page: 20 older items appear ABOVE, and the row the viewer was
		// looking at stays exactly where it was (scrollTop compensation). Focus
		// lands on the control's successor, not the document.
		await more.scrollIntoViewIfNeeded(); // the user scrolls up to the control
		const anchor = items.filter({ hasText: 'Pick 26' });
		const beforeY = (await anchor.boundingBox())!.y;
		await more.click();
		await expect(items).toHaveCount(40);
		await expect(items.first()).toContainText('Pick 06');
		expect(Math.abs((await anchor.boundingBox())!.y - beforeY)).toBeLessThanOrEqual(1);
		expect(await page.evaluate(() => (document.activeElement as HTMLElement).className)).toBe('ytb-hs-more');

		// A fresh Room read rebuilds the section; scrolled up, the chat rule
		// preserves both the reveal count and the exact scroll position.
		const topBefore = (await scrollState()).top;
		const reads = calls.filter((entry) => entry.startsWith('GET')).length;
		await page.evaluate(() => document.dispatchEvent(new CustomEvent('ytb:navigate', { detail: { url: location.href, videoId: null } })));
		await expect(() => expect(calls.filter((entry) => entry.startsWith('GET')).length).toBeGreaterThan(reads)).toPass();
		await expect(items).toHaveCount(40); // the reveal count survived the rebuild
		expect(Math.abs((await scrollState()).top - topBefore)).toBeLessThanOrEqual(1);

		// The final reveal renders the oldest item, removes the control, and moves
		// focus to the first revealed row instead of dropping the keyboard user.
		await more.click();
		await expect(items).toHaveCount(45);
		await expect(more).toHaveCount(0);
		await expect(items.first()).toContainText('Pick 01');
		expect(await page.evaluate(() => (document.activeElement as HTMLElement).className)).toContain('ytb-hs-item');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('a Room Feed reply row lands you at your own place, paused, with the Unseen dot pulsing — no seek, no panel (ADR-0010)', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		// The viewer authored a Note; a Buddy replied to it — so the Room Feed
		// carries a "replied to your note" row, and the reply leaves the Note's dot
		// Unseen (it addresses the viewer, and the seen set starts empty).
		await stubRoomBackend(context, {
			notes: [
				{
					id: 'note-1',
					clientId: 'viewer-e2e',
					name: 'Viewer',
					videoId: 'parent-video',
					timestamp: 4,
					kind: 'text',
					body: 'my moment',
					spoiler: false,
					createdAt: 1,
				},
			],
			replies: [{ id: 'reply-1', noteId: 'note-1', clientId: 'buddy-1', name: 'Sam', body: 'love this', createdAt: 2 }],
		});
		// The home route serves the browse fixture (where the Feed injects); the
		// watch route serves a playable fixture (where notes.js draws the dot).
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) => {
			const body = new URL(route.request().url()).pathname === '/watch' ? playbackFixture(mediaSrc) : homeFixture;
			return route.fulfill({ status: 200, contentType: 'text/html', body });
		});
		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');

		// Only the quoted body is the link (CONTEXT.md Room Feed link rule): the
		// row itself is not an anchor, and the author/action text is plain.
		const row = page.locator('#ytb-home-section .ytb-hs-item', { hasText: 'replied to your note' });
		await nudgeUntil(page, () => expect(row).toHaveCount(1, { timeout: 700 }));
		await expect(row.locator('a')).toHaveCount(1); // exactly one link — the body
		const link = row.locator('a.ytb-hs-text-link');
		await expect(link).toHaveText('"love this"'); // the quoted reply body only
		// The anchor hands you the VIDEO, not the moment: no `&t=` seek (ADR-0010).
		await expect(link).toHaveAttribute('href', '/watch?v=parent-video');
		// This Note captured no title, so the tooltip falls back to the video label.
		await expect(link).toHaveAttribute('title', 'Watch this video');

		// Clicking the body records the arrival handshake, then navigates to the
		// video (a full reload here; an SPA nav on real YouTube — it survives both).
		await link.click();
		await page.waitForURL(/\/watch\?v=parent-video$/);

		// No Expanded Note auto-opens: the panel is nowhere near the timeline it is
		// anchored to. The Unseen dot pulses instead, and you choose to open it.
		const dot = page.locator('.ytb-note-dot[data-ytb-note-id="note-1"]');
		await nudgeUntil(page, () => expect(dot).toHaveClass(/ytb-note-dot-unseen/, { timeout: 700 }));
		await expect(page.locator('#ytb-note-panel')).toHaveCount(0);

		// Arrival left the player paused at your own place, and it holds through the
		// watch page's autoplay settling. Reproduce the churn: a duplicate
		// navigation-finish for the SAME url plus the player's autoplay `play` (no
		// user gesture). The grace re-pauses it; the dot keeps pulsing (the row
		// click Acknowledged nothing), and still no panel.
		await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
		await page.evaluate(() => {
			const url = location.href;
			const videoId = new URL(url).searchParams.get('v');
			document.dispatchEvent(new CustomEvent('ytb:navigate', { detail: { url, videoId } }));
			document.querySelector('video')?.play();
		});
		await page.waitForTimeout(300);
		await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
		await expect(dot).toHaveClass(/ytb-note-dot-unseen/);
		await expect(page.locator('#ytb-note-panel')).toHaveCount(0);

		// The grace holds automatic play, but an explicit Picture Click with an
		// Expanded Note open cancels it and plays. Without cancellation the existing
		// capture-phase play listener would immediately re-pause this exact request.
		await dot.click();
		await expect(page.locator('#ytb-note-panel')).toBeVisible();
		await page
			.locator('video')
			.evaluate((video: HTMLVideoElement) =>
				video.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })),
			);
		await expect(page.locator('#ytb-note-panel')).toHaveCount(0);
		await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
		await page.waitForTimeout(300);
		expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('re-assigning a Buddy Color repaints the Note Dot, the open Expanded Note, and the Room Feed author, live in every open tab', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		// The viewer's own Note (a white dot; its Buddy reply also makes a Feed
		// row) plus a Buddy's Note (the colored dot whose panel we hold open).
		await stubRoomBackend(context, {
			notes: [
				{
					id: 'n-mine',
					clientId: 'viewer-e2e',
					name: 'Viewer',
					videoId: 'parent-video',
					timestamp: 4,
					kind: 'text',
					body: 'my moment',
					spoiler: false,
					createdAt: 1,
				},
				{
					id: 'n-buddy',
					clientId: 'buddy-1',
					name: 'Sam',
					videoId: 'parent-video',
					timestamp: 12,
					kind: 'text',
					body: 'from Sam',
					spoiler: false,
					createdAt: 2,
				},
			],
			replies: [{ id: 'reply-1', noteId: 'n-mine', clientId: 'buddy-1', name: 'Sam', body: 'love this', createdAt: 3 }],
		});
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) => {
			const body = new URL(route.request().url()).pathname === '/watch' ? playbackFixture(mediaSrc) : homeFixture;
			return route.fulfill({ status: 200, contentType: 'text/html', body });
		});
		const popup = await seedPairedRoom(context);

		// Tab 1: the home route's Room Feed, with Sam's colored author name.
		const home = await context.newPage();
		await home.goto('https://www.youtube.com/');
		const author = home.locator('#ytb-home-section .ytb-hs-author', { hasText: 'Sam' }).first();
		await nudgeUntil(home, () => expect(author).toBeVisible({ timeout: 700 }));

		// Tab 2: the watch route, with Sam's Note Dot and the viewer's own.
		const watch = await context.newPage();
		await watch.goto('https://www.youtube.com/watch?v=parent-video');
		const buddyDot = watch.locator('.ytb-note-dot[data-ytb-note-id="n-buddy"]');
		const ownDot = watch.locator('.ytb-note-dot[data-ytb-note-id="n-mine"]');
		await nudgeUntil(watch, () => expect(watch.locator('.ytb-note-dot')).toHaveCount(2, { timeout: 700 }));

		// Hold Sam's Expanded Note open so its byline is live DOM during the change.
		await buddyDot.click();
		const panel = watch.locator('#ytb-note-panel');
		await expect(panel).toBeVisible();
		const byline = panel.locator('.ytb-panel-author');
		await expect(byline).toHaveText('Sam');

		// Pick a target color that differs from the random initial allocation.
		const initial = await buddyDot.evaluate((el) => getComputedStyle(el).backgroundColor);
		const target = initial === 'rgb(232, 93, 4)' ? { hex: '#00a6d6', rgb: 'rgb(0, 166, 214)' } : { hex: '#e85d04', rgb: 'rgb(232, 93, 4)' };

		// Re-assign through the popup's chrome.storage.local — the real writer's
		// seam. No navigation and no reload follow; the repaint must be live.
		await popup.evaluate((hex) => chrome.storage.local.set({ buddyColors: { roome2e: { 'buddy-1': hex } } }), target.hex);

		// Every surface repaints in place, across both open tabs. Dots keep the
		// raw fill; author TEXT on card surfaces renders the ink-blended
		// text-safe variant (UA-001), so resolve the expected blend in-page.
		await expect(buddyDot).toHaveCSS('background-color', target.rgb);
		const blended = (page: Page, hex: string) =>
			page.evaluate((h) => {
				const probe = document.createElement('span');
				probe.style.color = `color-mix(in oklab, ${h} 50%, var(--ytb-ink))`;
				document.getElementById('ytb-note-panel')?.appendChild(probe) ?? document.body.appendChild(probe);
				const resolved = getComputedStyle(probe).color;
				probe.remove();
				return resolved;
			}, hex);
		await expect(byline).toHaveCSS('color', await blended(watch, target.hex));
		await expect(panel).toBeVisible(); // stayed open through the repaint
		await expect(author).toHaveCSS('color', await blended(home, target.hex));
		// The viewer's own dot is never tinted with a Buddy Color.
		await expect(ownDot).toHaveCSS('background-color', 'rgb(255, 255, 255)');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('a posted Note captures the video title, and Feed rows name the video — plain text, only when captured', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		const calls: string[] = [];
		// The viewer's titled Note, replied to by a Buddy; plus a Buddy's Note that
		// mentions the viewer and carries NO title (posted before Notes captured
		// one). The Feed must name the first video and stay silent about the second.
		await stubRoomBackend(
			context,
			{
				notes: [
					{
						id: 'note-1',
						clientId: 'viewer-e2e',
						name: 'Viewer',
						videoId: 'parent-video',
						videoTitle: 'Rick Astley - Never Gonna Give You Up',
						timestamp: 4,
						kind: 'text',
						body: 'my moment',
						spoiler: false,
						createdAt: 1,
					},
					{
						id: 'note-2',
						clientId: 'buddy-1',
						name: 'Sam',
						videoId: 'other-video',
						timestamp: 9,
						kind: 'text',
						body: 'hey @Viewer',
						spoiler: false,
						mentions: ['viewer-e2e'],
						createdAt: 3,
					},
				],
				replies: [{ id: 'reply-1', noteId: 'note-1', clientId: 'buddy-1', name: 'Sam', body: 'love this', createdAt: 2 }],
			},
			calls,
		);
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) => {
			const body = new URL(route.request().url()).pathname === '/watch' ? playbackFixture(mediaSrc) : homeFixture;
			return route.fulfill({ status: 200, contentType: 'text/html', body });
		});
		const popup = await seedPairedRoom(context);
		await popup.evaluate(() => chrome.storage.local.set({ sharing: false })); // Sharing off: it no longer gates Note posting (#194)

		// Posting: the composer freezes the watch page's title into the Note. The
		// fixture has no metadata heading, so this also exercises the tab-title
		// fallback in YTB.watchTitle.
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await page.locator('#ytb-note-button').click();
		await page.locator('#ytb-note-composer textarea').fill('great moment');
		await page.keyboard.press('Enter');
		await expect(page.locator('#ytb-note-composer')).toHaveCount(0);
		const notePost = calls.find((call) => call.startsWith('POST') && call.includes('/notes'));
		expect(notePost).toContain('"videoTitle":"YouTube playback fixture"');

		// Reading: the reply row names the video the conversation is on, as plain
		// deemphasized text that is NOT a link of its own.
		await page.goto('https://www.youtube.com/');
		const replyRow = page.locator('#ytb-home-section .ytb-hs-item', { hasText: 'replied to your note' });
		await nudgeUntil(page, () => expect(replyRow).toHaveCount(1, { timeout: 700 }));
		await expect(replyRow.locator('.ytb-hs-context')).toHaveText('on "Rick Astley - Never Gonna Give You Up"');
		await expect(replyRow.locator('.ytb-hs-context a')).toHaveCount(0);
		// The body link navigates to the video (no seek, ADR-0010); its tooltip
		// names that same video.
		await expect(replyRow.locator('a.ytb-hs-text-link')).toHaveAttribute('title', 'Watch "Rick Astley - Never Gonna Give You Up"');

		// A Note with no captured title names no video — never a placeholder.
		const mentionRow = page.locator('#ytb-home-section .ytb-hs-item', { hasText: 'mentioned you' });
		await expect(mentionRow).toHaveCount(1);
		await expect(mentionRow.locator('.ytb-hs-context')).toHaveCount(0);
		await expect(mentionRow.locator('a.ytb-hs-text-link')).toHaveAttribute('title', 'Watch this video');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// A home page carrying both live tile generations and a mimic of YouTube's
// shared popup plumbing, mirroring real markup (verified against production
// YouTube): every kebab click re-renders the ONE reused tp-yt-iron-dropdown in
// ytd-popup-container with that generation's menu shape — classic tiles get
// ytd-menu-popup-renderer > tp-yt-paper-listbox, lockup tiles get
// yt-sheet-view-model > yt-list-view-model.
const kebabFixture = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"><title>YouTube kebab fixture</title>
    <style>
      /* Give the custom elements real boxes so menu sizing is measurable. */
      tp-yt-iron-dropdown, ytd-menu-popup-renderer, tp-yt-paper-listbox,
      yt-sheet-view-model, yt-contextual-sheet-layout, yt-list-view-model { display: block; }
      ytd-menu-service-item-renderer, yt-list-item-view-model { display: block; height: 36px; }
    </style>
  </head>
  <body>
    <div id="guide">
      <ytd-guide-renderer>
        <div id="sections">
          <ytd-guide-section-renderer><div id="items"></div></ytd-guide-section-renderer>
        </div>
      </ytd-guide-renderer>
    </div>
    <ytd-browse page-subtype="home">
      <div id="grid-container">
        <ytd-rich-grid-renderer>
          <ytd-rich-item-renderer>
            <yt-lockup-view-model>
              <a href="/watch?v=vid-lockup"><img alt=""></a>
              <h3><a class="ytLockupMetadataViewModelTitle" href="/watch?v=vid-lockup">Lockup Video Title</a></h3>
              <button id="lockup-hover" aria-label="Watch later"></button>
              <button id="lockup-kebab" aria-label="More actions"></button>
            </yt-lockup-view-model>
          </ytd-rich-item-renderer>
          <ytd-video-renderer>
            <a id="video-title" title="Classic Video Title" href="/watch?v=vid-classic">Classic Video Title</a>
            <ytd-menu-renderer>
              <yt-icon-button><button id="classic-kebab" aria-label="Action menu"></button></yt-icon-button>
            </ytd-menu-renderer>
          </ytd-video-renderer>
        </ytd-rich-grid-renderer>
      </div>
    </ytd-browse>
    <ytd-popup-container></ytd-popup-container>
    <script>
      const container = document.querySelector('ytd-popup-container');
      function openMenu(html) {
        let dropdown = container.querySelector('tp-yt-iron-dropdown');
        if (!dropdown) {
          dropdown = document.createElement('tp-yt-iron-dropdown');
          container.appendChild(dropdown);
        }
        dropdown.removeAttribute('aria-hidden');
        dropdown.style.display = 'block';
        dropdown.innerHTML = '<div id="contentWrapper">' + html + '</div>';
        dropdown.dataset.opens = String(1 + Number(dropdown.dataset.opens || 0));
      }
      // Like YouTube, each popup opens pre-sized to ITS OWN items (an inline
      // max-height with nothing to spare), so an injected row overflows into a
      // scrollbar unless the extension grows the menu to fit.
      window.openLockupMenu = () => openMenu(
        '<yt-sheet-view-model><yt-contextual-sheet-layout style="overflow-y: auto; max-height: 36px">' +
        '<div class="ytContextualSheetLayoutContentContainer"><yt-list-view-model role="menu">' +
        '<yt-list-item-view-model role="menuitem"><span>Add to queue</span></yt-list-item-view-model>' +
        '</yt-list-view-model></div></yt-contextual-sheet-layout></yt-sheet-view-model>');
      window.openClassicMenu = () => openMenu(
        '<ytd-menu-popup-renderer role="menu" style="overflow-y: auto; max-height: 36px"><tp-yt-paper-listbox id="items" role="none">' +
        '<ytd-menu-service-item-renderer role="menuitem"><span>Add to queue</span></ytd-menu-service-item-renderer>' +
        '</tp-yt-paper-listbox></ytd-menu-popup-renderer>');
      window.closeMenu = () => {
        const dropdown = container.querySelector('tp-yt-iron-dropdown');
        if (dropdown) {
          dropdown.setAttribute('aria-hidden', 'true');
          dropdown.style.display = 'none';
        }
      };
      document.getElementById('lockup-kebab').addEventListener('click', () => setTimeout(window.openLockupMenu, 60));
      document.getElementById('classic-kebab').addEventListener('click', () => setTimeout(window.openClassicMenu, 60));
    </script>
  </body>
</html>`;

type KebabFixtureWindow = { openLockupMenu: () => void; closeMenu: () => void };

// Open (or re-open) a tile's kebab menu and resolve once the extension's single
// Recommend row has landed in the FRESHLY REBUILT generation. The fixture opens
// the menu asynchronously (a setTimeout) and bumps data-opens on every open,
// while the extension re-arms a 3s capture on every kebab click and injects the
// row only on a later throttled ytb:mutation. Under full-suite load those two
// async legs can drift far enough apart that the capture expires before the menu
// finishes opening, so the row never injects — the flake in #183. Re-clicking the
// kebab both re-arms that capture and forces a new generation, so wrapping the
// open in toPass makes a slow open recover instead of timing out. Gating the
// row assertion on data-opens having advanced past THIS click guarantees we
// resolve on the rebuilt row, never a doomed pre-rebuild instance racing the
// caller's click.
async function openKebabRow(page: Page, kebabId: string, listSelector: string) {
	const opensNow = () => page.evaluate(() => Number(document.querySelector<HTMLElement>('tp-yt-iron-dropdown')?.dataset.opens || 0));
	await expect(async () => {
		const before = await opensNow();
		await page.locator('#' + kebabId).click();
		// Wait for this click's rebuild (a new generation) before touching the row.
		await page.waitForFunction((n) => Number(document.querySelector<HTMLElement>('tp-yt-iron-dropdown')?.dataset.opens || 0) > n, before, {
			timeout: 3000,
		});
		// Nudge the throttled ytb:mutation so the extension reconciles the row in.
		await page.evaluate(() => document.body.appendChild(document.createComment('nudge')));
		await expect(page.locator(listSelector + ' .ytb-kebab-add')).toHaveCount(1, { timeout: 3000 });
	}).toPass({ timeout: 20_000 });
}

test('Recommend to Buddies row appears in both kebab menu generations and recommends the right video', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		const calls: string[] = [];
		await stubRoomBackend(
			context,
			{ playlist: [{ videoId: 'vid-room', title: 'Room Pick', addedBy: 'buddy-1', addedByName: 'Buddy', addedAt: 1000 }] },
			calls,
		);
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: kebabFixture }),
		);
		const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
		await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: pixel }));
		await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');

		// The paired Room renders the home section first — proof the Room config
		// and Room read both landed before any kebab interaction.
		const section = page.locator('#ytb-home-section');
		await nudgeUntil(page, () => expect(section.locator('.ytb-hs-card')).toHaveCount(1, { timeout: 700 }));

		const row = page.locator('.ytb-kebab-add');

		// The row must be FULLY visible in its pre-sized menu with no scrolling
		// (the extension grows the popup after injecting).
		const rowFullyVisible = (containerSelector: string) =>
			page.evaluate((selector) => {
				const container = document.querySelector<HTMLElement>(selector);
				const injected = container?.querySelector<HTMLElement>('.ytb-kebab-add');
				if (!container || !injected) return false;
				const c = container.getBoundingClientRect();
				const r = injected.getBoundingClientRect();
				return r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && container.scrollHeight <= container.clientHeight + 0.5;
			}, containerSelector);

		// Lockup generation: the row lands inside the sheet's list view model.
		await openKebabRow(page, 'lockup-kebab', 'yt-list-view-model');
		await expect(row).toContainText('Recommend to Buddies');
		expect(await rowFullyVisible('yt-contextual-sheet-layout')).toBe(true);

		// Re-opening the menu never stacks duplicates. The mimic (like YouTube)
		// rebuilds the menu content on each open, destroying the previous row —
		// openKebabRow waits for that fresh render (data-opens advances) before it
		// resolves, so the click below lands on the rebuilt row, never the doomed
		// first instance.
		await openKebabRow(page, 'lockup-kebab', 'yt-list-view-model');
		await expect(row).toHaveCount(1);

		// Activating it recommends THAT tile's video, with the lockup title class.
		await row.click();
		await expect(row).toContainText('Recommended');
		const lockupPosts = calls.filter((call) => call.startsWith('POST') && call.includes('/playlist'));
		expect(lockupPosts).toHaveLength(1);
		expect(lockupPosts[0]).toContain('"videoId":"vid-lockup"');
		expect(lockupPosts[0]).toContain('"title":"Lockup Video Title"');

		// The row never outlives its menu: the confirmation beat closes the
		// dropdown and the next mutation sweeps the row.
		await nudgeUntil(page, () => expect(row).toHaveCount(0, { timeout: 700 }));

		// Classic generation: same row inside the paper listbox, right video,
		// and the paper popup grows to fit it too.
		await openKebabRow(page, 'classic-kebab', 'tp-yt-paper-listbox');
		expect(await rowFullyVisible('ytd-menu-popup-renderer')).toBe(true);
		await row.click();
		await expect(row).toContainText('Recommended');
		const posts = calls.filter((call) => call.startsWith('POST') && call.includes('/playlist'));
		expect(posts).toHaveLength(2);
		expect(posts[1]).toContain('"videoId":"vid-classic"');
		expect(posts[1]).toContain('"title":"Classic Video Title"');
		await nudgeUntil(page, () => expect(row).toHaveCount(0, { timeout: 700 }));

		// The same network category uses the complete connectivity sentence in a
		// thumbnail menu. Its taller wrapped row refits the pre-sized menu instead
		// of clipping or adding a scrollbar.
		await context.route('http://localhost:8787/playlist**', (route) => {
			if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
			return route.abort('connectionrefused');
		});
		await openKebabRow(page, 'lockup-kebab', 'yt-list-view-model');
		await row.click();
		await expect(row).toHaveClass(/is-network-error/);
		await expect(row).toContainText("Can't reach the backend. Check your connection and try again.");
		expect(await rowFullyVisible('yt-contextual-sheet-layout')).toBe(true);
		expect((await row.boundingBox())?.width).toBeLessThanOrEqual(320);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('ERR_CONNECTION_REFUSED');
		errors.length = 0;
		await nudgeUntil(page, () => expect(row).toHaveCount(0, { timeout: 700 }));

		// A click inside the Room Home Section's own cards never arms the
		// capture: a menu opening right after stays row-free.
		await section.locator('.ytb-hs-remove').first().click();
		await page.evaluate(() => (window as unknown as KebabFixtureWindow).openLockupMenu());
		await page.waitForTimeout(900);
		await page.evaluate(() => document.body.appendChild(document.createComment('nudge')));
		await page.waitForTimeout(600);
		await expect(row).toHaveCount(0);
		await page.evaluate(() => (window as unknown as KebabFixtureWindow).closeMenu());

		// A stale capture (tile button clicked, but no menu opened) expires: a
		// menu opening after the 3s window stays row-free.
		await page.locator('#lockup-hover').click();
		await page.waitForTimeout(3200);
		await page.evaluate(() => (window as unknown as KebabFixtureWindow).openLockupMenu());
		await page.waitForTimeout(900);
		await page.evaluate(() => document.body.appendChild(document.createComment('nudge')));
		await page.waitForTimeout(600);
		await expect(row).toHaveCount(0);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('Settings view: gear/back, live theme, notes-off, buddy-progress-off, sharing relocation, home-section sync', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, {
			notes: roomNotes,
			progress: [{ clientId: 'buddy-1', name: 'Buddy', videoId: 'fixture-video', timestamp: 5, duration: 20, updatedAt: Date.now() }],
		});
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) => {
			const url = new URL(route.request().url());
			return route.fulfill({
				status: 200,
				contentType: 'text/html',
				body: url.pathname === '/watch' ? playbackFixture(mediaSrc) : homeFixture,
			});
		});
		const popup = await seedPairedRoom(context);
		await popup.reload(); // re-init the popup UI onto the seeded Room

		// Sharing was seeded OFF: the main view offers the prominent turn-on and
		// no read-only line. Turning it on is instant and flips the presentation.
		await expect(popup.locator('#view-connected')).toBeVisible();
		await expect(popup.locator('#sharing-turn-on')).toBeVisible();
		await expect(popup.locator('#sharing-on')).toBeHidden();
		await popup.locator('#sharing-turn-on').click();
		await expect(popup.locator('#sharing-on')).toBeVisible();
		await expect(popup.locator('#sharing-turn-on')).toBeHidden();

		// The gear opens Settings as a mutually-exclusive view.
		await popup.locator('#settings-open').click();
		await expect(popup.locator('#view-settings')).toBeVisible();
		await expect(popup.locator('#room-section')).toBeHidden();

		// A watch page with three Note dots, a Buddy marker, and the + button.
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0);
		});
		const dots = page.locator('.ytb-note-dot');
		await nudgeUntil(page, () => expect(dots).toHaveCount(3, { timeout: 700 }));
		await expect(page.locator('#ytb-note-button')).toBeVisible();
		await nudgeUntil(page, () => expect(page.locator('.ytb-watch-marker')).toHaveCount(1, { timeout: 700 }));

		// Theme Preference: forced Dark stamps data-theme on BOTH surfaces live.
		await popup.locator('[data-theme-choice="dark"]').click();
		await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

		// Auto (stored 'system', ADR-0009): the popup follows the OS so its marker
		// is unset, but in-page surfaces follow YouTube's own theme. The fixture is
		// a light page, so the watch page stamps data-theme="light".
		await popup.locator('[data-theme-choice="system"]').click();
		await expect.poll(() => popup.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

		// Flipping YouTube's appearance restamps the page live — no reload — while
		// the popup, which cannot see the page, stays unset.
		await page.evaluate(() => document.documentElement.setAttribute('dark', ''));
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.evaluate(() => document.documentElement.removeAttribute('dark'));
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await expect(popup.evaluate(() => document.documentElement.hasAttribute('data-theme'))).resolves.toBe(false);

		// Notes off: zero Note UI on the player, live — dots AND the + button —
		// while the Buddy marker (independent setting) survives. Back on restores.
		await popup.locator('#set-notes').click();
		await expect(dots).toHaveCount(0);
		await expect(page.locator('#ytb-note-button')).toHaveCount(0);
		await expect(page.locator('.ytb-watch-marker')).toHaveCount(1);
		await popup.locator('#set-notes').click();
		await nudgeUntil(page, () => expect(dots).toHaveCount(3, { timeout: 700 }));
		await expect(page.locator('#ytb-note-button')).toBeVisible();

		// Buddy Progress off: the timeline marker disappears live; dots stay.
		await popup.locator('#set-progress').click();
		await expect(page.locator('.ytb-watch-marker')).toHaveCount(0);
		await expect(dots).toHaveCount(3);
		await popup.locator('#set-progress').click();
		await nudgeUntil(page, () => expect(page.locator('.ytb-watch-marker')).toHaveCount(1, { timeout: 700 }));

		// Notification Position + Spoiler Default persist under their keys.
		await popup.locator('.edge-cell[data-edge="left"]').click();
		await expect(popup.locator('.edge-cell[data-edge="left"]')).toHaveAttribute('aria-checked', 'true');
		await popup.locator('#set-spoiler').click();
		await expect
			.poll(async () => popup.evaluate(() => chrome.storage.local.get(['notificationPosition', 'spoilerDefault'])))
			.toEqual({ notificationPosition: 'left', spoilerDefault: false });

		// The composer seeds its Spoiler checkbox from the new default.
		await page.locator('#ytb-note-button').click();
		const spoilerBox = page.locator('#ytb-note-composer input[type="checkbox"]');
		await expect(spoilerBox).toBeVisible();
		await expect(spoilerBox).not.toBeChecked();
		await page.keyboard.press('Escape');

		// Stop sharing now lives in Settings, confirm dialog intact.
		await popup.locator('#settings-sharing').click();
		await expect(popup.locator('#confirm-overlay')).toBeVisible();
		await popup.locator('#confirm-disconnect').click();
		await expect(popup.locator('#settings-sharing')).toHaveText('Start sharing');
		await popup.locator('#settings-sharing').click(); // starting is instant
		await expect(popup.locator('#settings-sharing')).toHaveText('Stop sharing');

		// Room Home Section visibility: the popup control and the guide toggle
		// drive the same key and stay in sync live, both directions.
		const home = await context.newPage();
		await home.goto('https://www.youtube.com/');
		const guideToggle = home.locator('#ytb-home-toggle');
		const homeSection = home.locator('#ytb-home-section');
		await expect(guideToggle).toBeVisible();
		await expect(homeSection).toHaveCount(1);
		await popup.locator('#set-home').click();
		await expect(homeSection).toHaveCount(0);
		await expect(guideToggle).toHaveAttribute('aria-checked', 'false');
		await guideToggle.click();
		await expect(homeSection).toHaveCount(1);
		await expect(popup.locator('#set-home')).toHaveAttribute('aria-checked', 'true');

		// Back returns to the room view Settings was opened from.
		await popup.locator('#settings-back').click();
		await expect(popup.locator('#view-settings')).toBeHidden();
		await expect(popup.locator('#view-connected')).toBeVisible();

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('@live loads on YouTube without content-script errors', async () => {
	test.skip(!process.env.YTB_LIVE_YOUTUBE, 'Set YTB_LIVE_YOUTUBE=1 to run the live smoke test.');
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
		// Unpaired, so the Add Note (+) button is intentionally absent (#194); assert
		// composer.js still mounted on real YouTube via its injected styles instead.
		await expect(page.locator('#ytb-composer-styles')).toBeAttached({ timeout: 20_000 });
		const extensions = await context.newPage();
		await expect((await extensionItem(extensions)).locator('#errors-button')).toHaveCount(0);
		// Live YouTube's own console noise, none of it ours: resource-load
		// failures, its ad-conversion pings rejected by CORS, and script blocks
		// inside its sandboxed ad frames.
		const isYouTubeNoise = (error: string) =>
			error.includes('Failed to load resource') ||
			(error.includes('blocked by CORS policy') && /doubleclick\.net|googleads/.test(error)) ||
			error.includes("Blocked script execution in 'about:blank'");
		const lifecycleErrors = errors.filter((error) => !isYouTubeNoise(error));
		expect(lifecycleErrors, lifecycleErrors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});
