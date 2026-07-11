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
 */
function stubRoomBackend(
	context: BrowserContext,
	read: { notes?: object[]; replies?: object[]; playlist?: object[]; progress?: object[]; events?: object[] },
	calls: string[] = [],
) {
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

		await expect(page.locator('#ytb-note-button')).toBeVisible();
		await expect(page.locator('#ytb-theme')).toHaveCount(1);
		await expect(page.locator('#ytb-renderer-style')).toHaveCount(1);
		await expect(page.locator('#ytb-notes-style')).toHaveCount(1);
		await expect(page.locator('#ytb-composer-styles')).toHaveCount(1);
		await expect(page.locator('#ytb-home-toggle-style')).toHaveCount(1);
		await expect(page.locator('#ytb-home-toggle')).toHaveCount(0); // guide row is home-route only
		await expect(page.locator('.ytb-thumb-bar')).toHaveCount(0);
		await page.waitForTimeout(750);
		const extensions = await context.newPage();
		const item = await extensionItem(extensions);
		await expect(item.locator('#errors-button')).toHaveCount(0);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// The feed thumbnail generations the Progress Bar must stay inside: a lockup
// tile whose /watch anchor is WIDER AND TALLER than its real thumbnail box
// (today's home/channel grids), a lockup tile carrying a simulated Watched Bar
// shaped like YouTube's live CSS (4px, margin 0 4px 4px 8px, 2px radius), and
// a classic tile whose anchor IS the thumbnail box (search; the extension's
// own Recommended-for-you cards share this shape).
const thumbBarFixture = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"><title>YouTube thumbnail-bar fixture</title>
    <style>
      body { margin: 0; padding: 24px; }
      ytd-rich-item-renderer, yt-lockup-view-model, yt-thumbnail-view-model,
      yt-thumbnail-bottom-overlay-view-model { display: block; }
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
  </body>
</html>`;

test('the thumbnail Progress Bar stays inside the thumbnail box, mirrors the Watched Bar, and stacks above it', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await stubRoomBackend(context, {
			progress: [
				// Sam hugs the left edge of vid-lockup so the tooltip clamp is provable.
				{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-lockup', timestamp: 2, duration: 100, updatedAt: 1 },
				{ clientId: 'buddy-2', name: 'Kim', videoId: 'vid-lockup', timestamp: 70, duration: 100, updatedAt: 2 },
				{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-watched', timestamp: 40, duration: 100, updatedAt: 3 },
				{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-classic', timestamp: 55, duration: 100, updatedAt: 4 },
			],
		});
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: thumbBarFixture }),
		);
		const popup = await seedPairedRoom(context);

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/');
		const bars = page.locator('.ytb-thumb-bar');
		await nudgeUntil(page, () => expect(bars).toHaveCount(3, { timeout: 700 }));

		const rect = (selector: string) =>
			page.evaluate((sel) => {
				const r = document.querySelector(sel)!.getBoundingClientRect();
				return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
			}, selector);

		// Lockup tile: the bar lives inside the REAL thumbnail box — never the
		// larger anchor — with the Watched Bar's geometry: 4px tall, inset
		// 0 4px 4px 8px, a 2px radius on the band strip.
		const lockupThumb = await rect('#lockup-thumb');
		const lockupBar = await rect('#lockup-thumb .ytb-thumb-bar');
		expect(lockupBar.height).toBeCloseTo(4, 1);
		expect(lockupBar.left).toBeCloseTo(lockupThumb.left + 8, 1);
		expect(lockupBar.right).toBeCloseTo(lockupThumb.right - 4, 1);
		expect(lockupBar.bottom).toBeCloseTo(lockupThumb.bottom - 4, 1);
		await expect(page.locator('#lockup-anchor > .ytb-thumb-bar')).toHaveCount(0);
		expect(await page.evaluate(() => getComputedStyle(document.querySelector('#lockup-thumb .ytb-thumb-track')!).borderRadius)).toBe('2px');
		// The box already establishes a positioning context, so no YouTube element
		// is mutated to position: relative.
		expect(await page.evaluate(() => document.querySelector<HTMLElement>('#lockup-anchor')!.style.position)).toBe('');

		// Band composition is unchanged: Sam owns [0 .. 2%], Kim [2% .. 70%], and
		// the fill ends at the furthest Buddy (the remainder stays transparent).
		const bands = await page.evaluate(() => {
			const track = document.querySelector('#lockup-thumb .ytb-thumb-track')!;
			const t = track.getBoundingClientRect();
			return [...track.children].map((seg) => {
				const r = seg.getBoundingClientRect();
				return { from: (r.left - t.left) / t.width, to: (r.right - t.left) / t.width };
			});
		});
		expect(bands).toHaveLength(2);
		expect(bands[0].from).toBeCloseTo(0, 2);
		expect(bands[0].to).toBeCloseTo(0.02, 2);
		expect(bands[1].from).toBeCloseTo(0.02, 2);
		expect(bands[1].to).toBeCloseTo(0.7, 2);

		// The duration badge is never painted over: the bar clears it entirely,
		// and it sits BEFORE the bottom overlay in the DOM so the badge would win
		// the paint order even if they ever met.
		const badge = await rect('#lockup-badge');
		expect(lockupBar.top).toBeGreaterThanOrEqual(badge.bottom - 0.5);
		expect(
			await page.evaluate(() => {
				const bar = document.querySelector('#lockup-thumb .ytb-thumb-bar')!;
				const overlay = document.querySelector('#lockup-thumb yt-thumbnail-bottom-overlay-view-model')!;
				return Boolean(bar.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING);
			}),
		).toBe(true);

		// Watched tile: the Progress Bar sits directly above the Watched Bar —
		// never covering it — still inside the thumbnail box.
		const watchedThumb = await rect('#watched-thumb');
		const watchedBar = await rect('#watched-bar');
		const stacked = await rect('#watched-thumb .ytb-thumb-bar');
		expect(stacked.bottom).toBeLessThanOrEqual(watchedBar.top + 0.5);
		expect(stacked.left).toBeCloseTo(watchedThumb.left + 8, 1);
		expect(stacked.right).toBeCloseTo(watchedThumb.right - 4, 1);
		expect(stacked.top).toBeGreaterThanOrEqual(watchedThumb.top);

		// Classic tile (the anchor IS the thumbnail box — search, and the same
		// shape as our Recommended-for-you cards): same inset slot.
		const classic = await rect('#classic-anchor');
		const classicBar = await rect('#classic-anchor .ytb-thumb-bar');
		expect(classicBar.left).toBeCloseTo(classic.left + 8, 1);
		expect(classicBar.right).toBeCloseTo(classic.right - 4, 1);
		expect(classicBar.bottom).toBeCloseTo(classic.bottom - 4, 1);

		// The hover tooltip survives the overflow: hidden box: Sam's band hugs the
		// left edge, so an unclamped centered tooltip would start left of the box.
		await page.locator('#lockup-thumb .ytb-thumb-seg').first().hover();
		const tip = page.locator('#lockup-thumb .ytb-thumb-bar > .ytb-watch-tooltip');
		await expect(tip).toHaveText('Sam · @0:02');
		await expect.poll(() => tip.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
		const tipRect = await rect('#lockup-thumb .ytb-thumb-bar > .ytb-watch-tooltip');
		expect(tipRect.left).toBeGreaterThanOrEqual(lockupThumb.left);
		expect(tipRect.right).toBeLessThanOrEqual(lockupThumb.right);

		// Recycle safety: a mutation pass over unchanged data must not rebuild the
		// bar (the signature guard) — a probe property survives the nudge.
		await page.evaluate(() => {
			(document.querySelector('#lockup-thumb .ytb-thumb-bar') as HTMLElement & { __ytbProbe?: boolean }).__ytbProbe = true;
		});
		await page.evaluate(() => document.body.appendChild(document.createComment('nudge')));
		await page.waitForTimeout(400);
		expect(
			await page.evaluate(
				() => (document.querySelector('#lockup-thumb .ytb-thumb-bar') as HTMLElement & { __ytbProbe?: boolean }).__ytbProbe,
			),
		).toBe(true);

		// Buddy Progress Visibility off removes every bar, live; back on restores.
		await popup.evaluate(() => chrome.storage.local.set({ buddyProgressHidden: true }));
		await expect(bars).toHaveCount(0);
		await popup.evaluate(() => chrome.storage.local.set({ buddyProgressHidden: false }));
		await nudgeUntil(page, () => expect(bars).toHaveCount(3, { timeout: 700 }));

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
		await expect(page.locator('#ytb-note-button')).toBeVisible();

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
		await expect(icon).toHaveCSS('color', 'rgb(246, 169, 107)');
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
		await expect(popup.locator('#status-sub')).toHaveText('Retrying…');
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

		// A successful read draws Bob's marker at 30/100 = 30%.
		const marker = page.locator('.ytb-watch-marker');
		await nudgeUntil(page, async () => {
			await expect(marker).toHaveCount(1);
		});
		expect(await marker.evaluate((el) => (el as HTMLElement).style.left)).toBe('30%');
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
		expect(await marker.evaluate((el) => (el as HTMLElement).style.left)).toBe('30%');

		await driveRead();
		await expect.poll(async () => (await broadcasts()).filter((b) => !b.ok).length).toBe(2);
		expect((await broadcasts()).at(-1)).toEqual({ ok: false, connectionLost: true });
		await expect(marker).toHaveCount(1);
		expect(await marker.evaluate((el) => (el as HTMLElement).style.left)).toBe('30%');

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
		expect(await marker.evaluate((el) => (el as HTMLElement).style.left)).toBe('30%');
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
		await expect(pill).toHaveText('Recommend to Buddies');
		await expect(page.locator('#ytb-playlist-feedback')).toHaveText(networkCopy);
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
		await pill.click();
		await expect(pill).toHaveText('Room list full');
		expect(errors).toHaveLength(3);
		expect(errors.every((error) => error.includes('409 (Conflict)'))).toBe(true);
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

		// Hovering the dot Acknowledges it: the pulse stops...
		await mentionDot.hover();
		await expect(mentionDot).not.toHaveClass(/ytb-note-dot-unseen/);
		// ...and the seen state lands in Room-scoped chrome.storage.local, never on
		// the wire (the stub records every request; none may carry the seen ids).
		await expect
			.poll(async () => popup.evaluate(async () => (await chrome.storage.local.get('seenItems')).seenItems))
			.toEqual({ roome2e: ['n-mention'] });

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
		await popup.evaluate(() => chrome.storage.local.set({ sharing: true })); // posting a Note requires Sharing

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
		await reactionDot.hover();

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

		// Clicking un-recommends: one DELETE /playlist attributed to the viewer,
		// after which the pill offers to recommend again.
		await pill.click();
		await expect(pill).toHaveText('Recommend to Buddies');
		const deletes = calls.filter((call) => call.startsWith('DELETE '));
		expect(deletes).toHaveLength(1);
		expect(deletes[0]).toContain('/playlist?code=roome2e&clientId=viewer-e2e&videoId=fixture-video');

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
					{ videoId: 'vid-own', title: 'My Own Pick', addedBy: 'viewer-e2e', addedByName: 'Viewer', addedAt: 1000 },
					{ videoId: 'vid-keep', title: 'Buddy Keeper', addedBy: 'buddy-1', addedByName: 'Buddy', addedAt: 2000 },
					{ videoId: 'vid-dismiss', title: 'Buddy Dismissed', addedBy: 'buddy-1', addedByName: 'Buddy', addedAt: 3000 },
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
			.poll(async () => popup.evaluate(() => chrome.storage.local.get('dismissedVideos')))
			.toEqual({ dismissedVideos: { roome2e: ['vid-dismiss'] } });

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

		// Every surface repaints in place, across both open tabs.
		await expect(buddyDot).toHaveCSS('background-color', target.rgb);
		await expect(byline).toHaveCSS('color', target.rgb);
		await expect(panel).toBeVisible(); // stayed open through the repaint
		await expect(author).toHaveCSS('color', target.rgb);
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
		await popup.evaluate(() => chrome.storage.local.set({ sharing: true })); // posting a Note requires Sharing

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
		await page.locator('#lockup-kebab').click();
		await nudgeUntil(page, () => expect(page.locator('yt-list-view-model .ytb-kebab-add')).toHaveCount(1, { timeout: 700 }));
		await expect(row).toContainText('Recommend to Buddies');
		expect(await rowFullyVisible('yt-contextual-sheet-layout')).toBe(true);

		// Re-opening the menu never stacks duplicates. The mimic (like YouTube)
		// rebuilds the menu content on each open, destroying the previous row —
		// wait for that second render before touching the fresh row, or the click
		// below would race the rebuild and land on the doomed first instance.
		await page.locator('#lockup-kebab').click();
		await page.waitForFunction(() => document.querySelector<HTMLElement>('tp-yt-iron-dropdown')?.dataset.opens === '2');
		await nudgeUntil(page, () => expect(page.locator('yt-list-view-model .ytb-kebab-add')).toHaveCount(1, { timeout: 700 }));
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
		await page.locator('#classic-kebab').click();
		await nudgeUntil(page, () => expect(page.locator('tp-yt-paper-listbox .ytb-kebab-add')).toHaveCount(1, { timeout: 700 }));
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
		await page.locator('#lockup-kebab').click();
		await nudgeUntil(page, () => expect(page.locator('yt-list-view-model .ytb-kebab-add')).toHaveCount(1, { timeout: 700 }));
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
		await expect(page.locator('#ytb-note-button')).toBeAttached({ timeout: 20_000 });
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
