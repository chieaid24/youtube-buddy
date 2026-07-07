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
							{ id: 'note-1', clientId: 'buddy-1', name: 'Sam', videoId: 'fixture-video', timestamp: 2, kind: 'text', body: 'great moment', createdAt: 1 },
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
		await context.route('https://www.youtube.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: homeFixture }));
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
	{ id: 'n-text', clientId: 'buddy-1', name: 'Buddy', videoId: 'fixture-video', timestamp: 4, kind: 'text', body: 'hello', spoiler: false, createdAt: 1 },
	{ id: 'n-react', clientId: 'buddy-1', name: 'Buddy', videoId: 'fixture-video', timestamp: 8, kind: 'emoji', body: '\u{1F525}', spoiler: false, createdAt: 2 },
	{ id: 'n-spoiler', clientId: 'buddy-1', name: 'Buddy', videoId: 'fixture-video', timestamp: 16, kind: 'text', body: 'secret', spoiler: true, createdAt: 3 },
];

test('Reaction dot click is a bare state-preserving seek; text and Spoiler dots keep their behavior', async () => {
	const context = await launchExtension();
	const errors = collectErrors(context);

	try {
		// Stand in for the backend: GET returns the Room read above; writes are
		// swallowed. Content-script fetches run under the page origin, so the
		// stub must answer CORS like the real Worker does.
		const cors = {
			'access-control-allow-origin': '*',
			'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
			'access-control-allow-headers': 'content-type',
		};
		await context.route('http://localhost:8787/**', (route) => {
			const method = route.request().method();
			if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
			if (method === 'GET') {
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					headers: cors,
					body: JSON.stringify({ progress: [], presence: [], notes: roomNotes, replies: [], playlist: [], events: [] }),
				});
			}
			return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ ok: true }) });
		});
		const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;
		await context.route('https://www.youtube.com/**', (route) =>
			route.fulfill({ status: 200, contentType: 'text/html', body: playbackFixture(mediaSrc) }),
		);

		// Seed the paired-Room config through an extension page (chrome.storage
		// is only reachable from the extension's own origin).
		const extensions = await context.newPage();
		const extensionId = await (await extensionItem(extensions)).getAttribute('id');
		const popup = await context.newPage();
		await popup.goto(`chrome-extension://${extensionId}/popup.html`);
		await popup.evaluate(() => chrome.storage.local.set({ code: 'ROOME2E', clientId: 'viewer-e2e', name: 'Viewer', sharing: false }));

		const page = await context.newPage();
		await page.goto('https://www.youtube.com/watch?v=fixture-video');
		const video = page.locator('video');
		await page.waitForFunction(() => {
			const v = document.querySelector('video');
			return Boolean(v && Number.isFinite(v.duration) && v.duration > 0 && v.seekable.length && v.seekable.end(0) >= v.duration - 0.5);
		});

		// The initial render can race the media metadata (dots need a finite
		// duration); nudge the DOM so content.js re-emits ytb:mutation until the
		// three dots reconcile.
		const dots = page.locator('.ytb-note-dot');
		await expect(async () => {
			await page.evaluate(() => document.body.appendChild(document.createComment('nudge')));
			await expect(dots).toHaveCount(3, { timeout: 700 });
		}).toPass({ timeout: 15_000 });
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
