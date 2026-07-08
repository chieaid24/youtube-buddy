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
	read: { notes?: object[]; playlist?: object[]; progress?: object[] },
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
					replies: [],
					playlist: read.playlist ?? [],
					events: [],
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

		// Default: toggle on (checked) inside the guide, section rendered.
		const toggle = page.locator('#ytb-home-toggle');
		const section = page.locator('#ytb-home-section');
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('ytd-guide-renderer #items #ytb-home-toggle')).toHaveCount(1);
		await expect(section).toHaveCount(1);

		// Off: the section is removed completely, and mutation churn must not
		// re-inject it; the toggle row itself stays available in the guide.
		await toggle.click();
		await expect(section).toHaveCount(0);
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
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

// One Buddy-authored Note of each dot kind on a 20s video. goHereTarget is 1s
// before the timestamp, so the Reaction seeks to 7 and the Spoiler to 15.
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

test('Reaction dot click is a bare state-preserving seek; text and Spoiler dots keep their behavior', async () => {
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

		const state = () => video.evaluate((v: HTMLVideoElement) => ({ currentTime: v.currentTime, paused: v.paused }));

		// Paused Reaction click: seeks to goHereTarget(8) = 7 and stays paused.
		expect((await state()).paused).toBe(true);
		await page.locator('.ytb-note-dot-reaction').click();
		let s = await state();
		expect(s.currentTime).toBeGreaterThanOrEqual(6.7);
		expect(s.currentTime).toBeLessThan(7.3);
		expect(s.paused).toBe(true);

		// Playing Reaction click: same seek, and playback keeps running.
		await video.evaluate((v: HTMLVideoElement) => {
			v.currentTime = 0;
			return v.play();
		});
		expect((await state()).paused).toBe(false);
		await page.locator('.ytb-note-dot-reaction').click();
		s = await state();
		expect(s.currentTime).toBeGreaterThanOrEqual(6.7);
		expect(s.currentTime).toBeLessThan(8.5);
		expect(s.paused).toBe(false);

		// Locked Spoiler click is still Go here: seeks to goHereTarget(16) = 15
		// AND resumes playback from paused.
		await video.evaluate((v: HTMLVideoElement) => v.pause());
		await page.locator('.ytb-note-dot-locked').click();
		await expect.poll(async () => (await state()).paused).toBe(false);
		s = await state();
		expect(s.currentTime).toBeGreaterThanOrEqual(14.7);
		expect(s.currentTime).toBeLessThan(16);

		// Text Note click still opens the conversation panel without seeking.
		await video.evaluate((v: HTMLVideoElement) => v.pause());
		const before = (await state()).currentTime;
		await page.locator('.ytb-note-dot-text').click();
		await expect(page.locator('#ytb-note-panel')).toBeVisible();
		s = await state();
		expect(s.currentTime).toBeCloseTo(before, 1);
		expect(s.paused).toBe(true);

		expect(errors, errors.join('\n')).toEqual([]);
	} finally {
		await context.close();
	}
});

// A watch page with the Like/Share/Save actions row, where playlist-add.js
// injects the "+ Buddy Room" recommend pill.
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

		// The pill lands as "+ Buddy Room" and flips to the "Recommended" toggle
		// state once the Room read shows this viewer recommended the video.
		const pill = page.locator('#ytb-playlist-add-button');
		await nudgeUntil(page, () => expect(pill).toHaveText('Recommended', { timeout: 700 }));

		// Clicking un-recommends: one DELETE /playlist attributed to the viewer,
		// after which the pill offers to recommend again.
		await pill.click();
		await expect(pill).toHaveText('+ Buddy Room');
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

// A home page carrying both live tile generations and a mimic of YouTube's
// shared popup plumbing, mirroring real markup (verified against production
// YouTube): every kebab click re-renders the ONE reused tp-yt-iron-dropdown in
// ytd-popup-container with that generation's menu shape — classic tiles get
// ytd-menu-popup-renderer > tp-yt-paper-listbox, lockup tiles get
// yt-sheet-view-model > yt-list-view-model.
const kebabFixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>YouTube kebab fixture</title></head>
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
      window.openLockupMenu = () => openMenu(
        '<yt-sheet-view-model><yt-contextual-sheet-layout>' +
        '<div class="ytContextualSheetLayoutContentContainer"><yt-list-view-model role="menu">' +
        '<yt-list-item-view-model role="menuitem"><span>Add to queue</span></yt-list-item-view-model>' +
        '</yt-list-view-model></div></yt-contextual-sheet-layout></yt-sheet-view-model>');
      window.openClassicMenu = () => openMenu(
        '<ytd-menu-popup-renderer role="menu"><tp-yt-paper-listbox id="items" role="none">' +
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

test('Add to Buddy Room row appears in both kebab menu generations and recommends the right video', async () => {
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

		// Lockup generation: the row lands inside the sheet's list view model.
		await page.locator('#lockup-kebab').click();
		await nudgeUntil(page, () => expect(page.locator('yt-list-view-model .ytb-kebab-add')).toHaveCount(1, { timeout: 700 }));
		await expect(row).toContainText('Add to Buddy Room');

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
		await expect(row).toContainText('Added to Buddy Room');
		const lockupPosts = calls.filter((call) => call.startsWith('POST') && call.includes('/playlist'));
		expect(lockupPosts).toHaveLength(1);
		expect(lockupPosts[0]).toContain('"videoId":"vid-lockup"');
		expect(lockupPosts[0]).toContain('"title":"Lockup Video Title"');

		// The row never outlives its menu: the confirmation beat closes the
		// dropdown and the next mutation sweeps the row.
		await nudgeUntil(page, () => expect(row).toHaveCount(0, { timeout: 700 }));

		// Classic generation: same row inside the paper listbox, right video.
		await page.locator('#classic-kebab').click();
		await nudgeUntil(page, () => expect(page.locator('tp-yt-paper-listbox .ytb-kebab-add')).toHaveCount(1, { timeout: 700 }));
		await row.click();
		await expect(row).toContainText('Added to Buddy Room');
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

		// Theme Preference: Dark stamps data-theme on BOTH surfaces live; System
		// removes it again (back to prefers-color-scheme).
		await popup.locator('[data-theme-choice="dark"]').click();
		await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await popup.locator('[data-theme-choice="system"]').click();
		await expect.poll(() => popup.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
		await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);

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
		await popup.locator('.zone-cell[data-zone="top-left"]').click();
		await expect(popup.locator('.zone-cell[data-zone="top-left"]')).toHaveAttribute('aria-checked', 'true');
		await popup.locator('#set-spoiler').click();
		await expect
			.poll(async () => popup.evaluate(() => chrome.storage.local.get(['notificationPosition', 'spoilerDefault'])))
			.toEqual({ notificationPosition: 'top-left', spoilerDefault: false });

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
