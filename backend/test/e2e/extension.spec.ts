import { expect, test, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';

const extensionPath = path.resolve(__dirname, '../../../extension');

// The scrubber tooltip merges both live markup variants: the current ("delhi")
// player carries the hover timecode in .ytp-tooltip-progress-bar-pill and
// leaves .ytp-tooltip-text empty; the legacy player carries it in
// .ytp-tooltip-text. The fixture fills both so one hover asserts both hide.
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
      <div class="ytp-tooltip ytp-bottom ytp-tooltip-progress-bar-style ytp-preview">
        <div class="ytp-tooltip-bg"></div>
        <div class="ytp-tooltip-text-wrapper">
          <span class="ytp-tooltip-text">1:23</span>
          <div class="ytp-tooltip-progress-bar-pill">
            <div class="ytp-tooltip-progress-bar-pill-time-stamp">1:23</div>
          </div>
        </div>
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

test('hovering a Note dot hides the native scrubber timecode, keeping the thumbnail', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		await context.route('https://www.youtube.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		await expect(page.locator('#ytb-note-button')).toBeVisible();

		// Render one Note dot. The content scripts run in an isolated world, so a
		// main-world `Object.defineProperty(video, 'duration', ...)` is invisible
		// to them — give the fixture <video> a real media source instead (native
		// element state is shared across worlds) and wait for its metadata.
		// CustomEvent detail crosses worlds via structured clone in Chromium, so
		// dispatching the Room read the way renderer.js rebroadcasts one works.
		await page.evaluate(async (wavDataUri) => {
			const video = document.querySelector('video') as HTMLVideoElement;
			const loaded = new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
			video.src = wavDataUri;
			await loaded;
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
								timestamp: 2,
								kind: 'text',
								body: 'great moment',
								createdAt: 1,
							},
						],
						replies: [],
					},
				}),
			);
		}, silentWavDataUri(4));
		const dot = page.locator('.ytb-note-dot');
		await expect(dot).toHaveCount(1);

		const visibilityOf = (selector: string) =>
			page.evaluate((sel) => getComputedStyle(document.querySelector(sel) as Element).visibility, selector);

		// Native timecode carriers (delhi pill + legacy text) start visible.
		expect(await visibilityOf('.ytp-tooltip-progress-bar-pill')).toBe('visible');
		expect(await visibilityOf('.ytp-tooltip-text')).toBe('visible');

		// Hovering the dot suppresses the timecode but never the storyboard.
		await dot.hover();
		await expect.poll(() => visibilityOf('.ytp-tooltip-progress-bar-pill')).toBe('hidden');
		expect(await visibilityOf('.ytp-tooltip-text')).toBe('hidden');
		expect(await visibilityOf('.ytp-tooltip-bg')).toBe('visible');

		// Leaving the dot restores the native timecode.
		await page.mouse.move(10, 10);
		await expect.poll(() => visibilityOf('.ytp-tooltip-progress-bar-pill')).toBe('visible');
		expect(await visibilityOf('.ytp-tooltip-text')).toBe('visible');

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

test('Room Home Toggle hides and restores the Room Home Section, persisting across reload and SPA nav', async () => {
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

		// Inline styles own the placement (applyAlertsPosition).
		const anchor = () =>
			page.locator('#ytb-note-alerts').evaluate((node) => {
				const s = (node as HTMLElement).style;
				return { top: s.top, bottom: s.bottom, left: s.left, right: s.right, transform: s.transform, alignItems: s.alignItems };
			});
		const setEdge = (edge: string) => popup.evaluate((e) => chrome.storage.local.set({ notificationPosition: e }), edge);

		// Default is bottom: horizontally centered, offset up from the bottom.
		let a = await anchor();
		expect(a.left).toBe('50%');
		expect(a.transform).toBe('translateX(-50%)');
		expect(a.top).toBe('');
		expect(a.right).toBe('');
		expect(a.alignItems).toBe('center');
		expect(a.bottom).toMatch(/^\d+(\.\d+)?px$/);

		// top: horizontally centered, offset down from the top.
		await setEdge('top');
		await expect.poll(async () => (await anchor()).bottom).toBe('');
		a = await anchor();
		expect(a.left).toBe('50%');
		expect(a.transform).toBe('translateX(-50%)');
		expect(a.alignItems).toBe('center');
		expect(a.top).toMatch(/^\d+(\.\d+)?px$/);

		// left: vertically centered against the left edge.
		await setEdge('left');
		await expect.poll(async () => (await anchor()).left).toBe('16px');
		a = await anchor();
		expect(a.top).toBe('50%');
		expect(a.transform).toBe('translateY(-50%)');
		expect(a.bottom).toBe('');
		expect(a.right).toBe('');
		expect(a.alignItems).toBe('flex-start');

		// right: vertically centered against the right edge.
		await setEdge('right');
		await expect.poll(async () => (await anchor()).right).toBe('16px');
		a = await anchor();
		expect(a.top).toBe('50%');
		expect(a.transform).toBe('translateY(-50%)');
		expect(a.bottom).toBe('');
		expect(a.left).toBe('');
		expect(a.alignItems).toBe('flex-end');

		// A stale 8-zone value is not an edge: fall back to the bottom default.
		await setEdge('top-right');
		await expect.poll(async () => (await anchor()).top).toBe('');
		a = await anchor();
		expect(a.left).toBe('50%');
		expect(a.transform).toBe('translateX(-50%)');
		expect(a.bottom).toMatch(/^\d+(\.\d+)?px$/);

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
// where a Reaction hover preview renders — so the storyboard-clearing cap can
// be asserted deterministically (the real player positions the same element
// live; verified there too).
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

test('a hovered Reaction preview is capped so its top clears the storyboard thumbnail', async () => {
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

		// The cap pulls the Reaction preview's top down to or below the storyboard
		// thumbnail's bottom edge (it starts above it, clipped, without the cap).
		await expect
			.poll(() =>
				page.evaluate(() => {
					const pv = document.querySelector('.ytb-note-dot-reaction .ytb-note-preview').getBoundingClientRect();
					const tip = document.querySelector('.ytp-tooltip').getBoundingClientRect();
					return Math.round(pv.top - tip.bottom); // >= 0: preview top sits below the thumbnail
				}),
			)
			.toBeGreaterThanOrEqual(0);

		// The emoji itself stays fully inside the capped preview (only empty top
		// padding is trimmed), and its timestamp chip is dropped for room.
		const state = await page.evaluate(() => {
			const preview = document.querySelector('.ytb-note-dot-reaction .ytb-note-preview');
			const pv = preview.getBoundingClientRect();
			const em = document.querySelector('.ytb-note-dot-reaction .ytb-preview-emoji').getBoundingClientRect();
			return {
				emojiInside: em.height > 0 && em.top >= pv.top - 0.5 && em.bottom <= pv.bottom + 0.5,
				clamped: preview.classList.contains('ytb-preview-clamped'),
				chipHidden: getComputedStyle(document.querySelector('.ytb-note-dot-reaction .ytb-preview-time')).display === 'none',
			};
		});
		expect(state).toEqual({ emojiInside: true, clamped: true, chipHidden: true });

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

test('watch pill shows Recommended on an own Recommendation and un-recommends for everyone', async () => {
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

		// The pill lands as "Recommend to Buddies" and flips to the "Recommended"
		// toggle state once the Room read shows this viewer recommended the video.
		const pill = page.locator('#ytb-playlist-add-button');
		await nudgeUntil(page, () => expect(pill).toHaveText('Recommended', { timeout: 700 }));

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
		// Recommendation, the viewer's own live Recommendation, and a Buddy
		// recommend whose videoId has since left the live list (un-recommended;
		// removals emit NO event — ADR-0007). The Buddy also has a Progress
		// Record for the viewer's pick, producing a Watch Notice.
		await stubRoomBackend(context, {
			progress: [{ clientId: 'buddy-1', name: 'Sam', videoId: 'vid-own', timestamp: 30, duration: 100, updatedAt: 4000 }],
			playlist: [
				{ videoId: 'vid-live', title: 'Buddy Pick', addedBy: 'buddy-1', addedByName: 'Sam', addedAt: 1000 },
				{ videoId: 'vid-own', title: 'My Pick', addedBy: 'viewer-e2e', addedByName: 'Viewer', addedAt: 2000 },
			],
			events: [
				{ id: 'e1', type: 'added', videoId: 'vid-live', title: 'Buddy Pick', actorClientId: 'buddy-1', at: 1000 },
				{ id: 'e2', type: 'added', videoId: 'vid-own', title: 'My Pick', actorClientId: 'viewer-e2e', at: 2000 },
				{ id: 'e3', type: 'added', videoId: 'vid-gone', title: 'Gone Pick', actorClientId: 'buddy-1', at: 3000 },
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

		// Three System Messages + one Watch Notice, all on the quiet system row.
		const rows = page.locator('#ytb-home-section .ytb-hs-system');
		await nudgeUntil(page, () => expect(rows).toHaveCount(4, { timeout: 700 }));

		// Recipient copy drops "you"; ONLY the quoted title is a link.
		const recipient = rows.filter({ hasText: 'Sam recommended "Buddy Pick"' });
		await expect(recipient).toHaveCount(1);
		await expect(page.locator('#ytb-home-section')).not.toContainText('recommended you');
		await expect(recipient.locator('a')).toHaveCount(1);
		await expect(recipient.locator('a.ytb-hs-title-link')).toHaveText('"Buddy Pick"');
		await expect(recipient.locator('a.ytb-hs-title-link')).toHaveAttribute('href', '/watch?v=vid-live');

		// The recommender now sees their own line, title-linked the same way.
		const own = rows.filter({ hasText: 'You recommended "My Pick" to the Room' });
		await expect(own).toHaveCount(1);
		await expect(own.locator('a.ytb-hs-title-link')).toHaveAttribute('href', '/watch?v=vid-own');

		// The un-recommended line renders struck through (its sentence span), the
		// live one does not.
		const decorationOf = (row: typeof recipient) =>
			row.evaluate((el) => getComputedStyle(el.querySelector('span') as Element).textDecorationLine);
		const struck = rows.filter({ hasText: 'Sam recommended "Gone Pick"' });
		await expect(struck).toHaveCount(1);
		expect(await decorationOf(struck)).toBe('line-through');
		expect(await decorationOf(recipient)).not.toBe('line-through');

		// The Watch Notice's quoted title links to the video too.
		const watch = rows.filter({ hasText: 'Sam watched "My Pick"' });
		await expect(watch).toHaveCount(1);
		await expect(watch.locator('a.ytb-hs-title-link')).toHaveAttribute('href', '/watch?v=vid-own');

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

test('a Room Feed reply row opens its Expanded Note on arrival — only the body links, and it survives load churn', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		// The viewer authored a Note; a Buddy replied to it — so the Room Feed
		// carries a "replied to your note" row pointing at that Note.
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
		// watch route serves a playable fixture (where notes.js opens the panel).
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
		await expect(link).toHaveAttribute('href', '/watch?v=parent-video&t=4'); // seek baked in

		// Clicking the body records the open-target, then navigates to the video (a
		// full reload here; an SPA nav on real YouTube — the handshake survives both).
		await link.click();
		await page.waitForURL(/\/watch\?v=parent-video&t=4$/);

		// On arrival the parent Note's Expanded Note opens once its Room read lands.
		const panel = page.locator('#ytb-note-panel');
		await expect(panel).toBeVisible();
		await expect(panel.locator('.ytb-panel-body')).toContainText('my moment');

		// Load churn must NOT dismiss it. Reproduce the two culprits: a duplicate
		// navigation-finish for the SAME url (YouTube re-emits these as the watch
		// page settles) and the player's autoplay `play` (no user gesture) starting
		// after the panel opened. Both leave the panel open, and the play is
		// re-paused so the viewer can read the Note.
		await page.evaluate(() => {
			const url = location.href;
			const videoId = new URL(url).searchParams.get('v');
			document.dispatchEvent(new CustomEvent('ytb:navigate', { detail: { url, videoId } }));
			document.querySelector('video')?.play();
		});
		await page.waitForTimeout(300);
		await expect(panel).toBeVisible();
		await expect(panel.locator('.ytb-panel-body')).toContainText('my moment');
		await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

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

		// A Note with no captured title names no video — never a placeholder.
		const mentionRow = page.locator('#ytb-home-section .ytb-hs-item', { hasText: 'mentioned you' });
		await expect(mentionRow).toHaveCount(1);
		await expect(mentionRow.locator('.ytb-hs-context')).toHaveCount(0);

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
		const lifecycleErrors = errors.filter((error) => !error.includes('Failed to load resource'));
		expect(lifecycleErrors, lifecycleErrors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});
