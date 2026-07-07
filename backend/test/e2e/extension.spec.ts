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
		args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
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
