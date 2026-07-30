// Shared harness for the ui-audit probes (UA-xxx.spec.ts). Each probe
// reproduces one audited finding as a live measurement, so it is red while the
// finding stands and green once the fix lands. Mirrors extension.spec.ts's
// deterministic setup: unpacked extension, stubbed backend, YouTube fixtures.
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';

export const extensionPath = path.resolve(__dirname, '../../../../extension');

export const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
	'access-control-allow-headers': 'content-type',
};

export async function launchExtension(): Promise<BrowserContext> {
	return chromium.launchPersistentContext('', {
		channel: 'chromium',
		headless: true,
		args: [
			`--disable-extensions-except=${extensionPath}`,
			`--load-extension=${extensionPath}`,
			'--autoplay-policy=no-user-gesture-required',
			'--force-device-scale-factor=1',
		],
	});
}

function silentWav(seconds: number): Buffer {
	const sampleRate = 8000;
	const dataSize = sampleRate * seconds;
	const wav = Buffer.alloc(44 + dataSize, 0x80);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(36 + dataSize, 4);
	wav.write('WAVE', 8);
	wav.write('fmt ', 12);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate, 28);
	wav.writeUInt16LE(1, 32);
	wav.writeUInt16LE(8, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(dataSize, 40);
	return wav;
}
export const mediaSrc = `data:audio/wav;base64,${silentWav(20).toString('base64')}`;

export const playbackFixture = `<!doctype html>
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

export const homeFixture = `<!doctype html>
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

export const watchedByDotsFixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>YouTube watched-by-dots fixture</title>
    <style>body { margin: 0; padding: 24px; } ytd-rich-item-renderer, yt-lockup-view-model, yt-thumbnail-view-model { display: block; }</style>
  </head>
  <body>
    <a id="classic-anchor" href="/watch?v=vid-classic" style="display: block; width: 320px; height: 180px; background: #222; margin-top: 16px">
      <img alt="" style="display: block; width: 100%; height: 100%">
    </a>
    <a id="classic-two" href="/watch?v=vid-two" style="display: block; width: 320px; height: 180px; background: #222; margin-top: 16px">
      <img alt="" style="display: block; width: 100%; height: 100%">
    </a>
  </body>
</html>`;

export const PIXEL_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
	'base64',
);

export const SEED_COLORS = { 'silly-otters': { 'buddy-1': '#00a6d6', 'buddy-2': '#f0a500' } };
export const VIEWER = 'viewer-ua';

export type RoomRead = {
	progress?: object[];
	presence?: object[];
	notes?: object[];
	replies?: object[];
	playlist?: object[];
	events?: object[];
};

export type BackendState = { down: boolean; read: () => RoomRead };

export function routeBackend(context: BrowserContext, state: BackendState) {
	return context.route('http://localhost:8787/**', (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
		if (request.method() === 'GET') {
			if (state.down) return route.abort('connectionrefused');
			const data = state.read();
			const body =
				url.pathname === '/conversation'
					? {
							note: (data.notes || []).find((n: any) => n.id === url.searchParams.get('noteId')) || null,
							replies: (data.replies || []).filter((r: any) => r.noteId === url.searchParams.get('noteId')),
						}
					: {
							progress: data.progress || [],
							presence: data.presence || [],
							notes: data.notes || [],
							replies: data.replies || [],
							playlist: data.playlist || [],
							events: data.events || [],
						};
			return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
		}
		return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: true }) });
	});
}

/** The audited Room data set (mirrors the capture run). */
export function makeData(now: number) {
	const MIN = 60_000;
	const HOUR = 3_600_000;
	const presence = [
		{ clientId: VIEWER, name: 'Alex', updatedAt: now - 30_000 },
		{ clientId: 'buddy-1', name: 'Sam', updatedAt: now - 5.5 * MIN },
		{ clientId: 'buddy-2', name: 'Kim', updatedAt: now - 2.5 * HOUR },
	];
	const progress = [
		{ clientId: 'buddy-1', name: 'Sam', videoId: 'fixture-video', timestamp: 6, duration: 20, updatedAt: now - 5.5 * MIN },
		{ clientId: 'buddy-2', name: 'Kim', videoId: 'fixture-video', timestamp: 14, duration: 20, updatedAt: now - 2.5 * HOUR },
	];
	const notes = [
		{
			id: 'n-text',
			clientId: 'buddy-1',
			name: 'Sam',
			videoId: 'fixture-video',
			timestamp: 4,
			kind: 'text',
			body: 'This part is amazing',
			spoiler: false,
			createdAt: now - 2.5 * HOUR,
		},
		{
			id: 'n-react',
			clientId: 'buddy-2',
			name: 'Kim',
			videoId: 'fixture-video',
			timestamp: 8,
			kind: 'emoji',
			body: '\u{1F525}',
			spoiler: false,
			createdAt: now - 2.5 * HOUR,
		},
		{
			id: 'n-own',
			clientId: VIEWER,
			name: 'Alex',
			videoId: 'fixture-video',
			timestamp: 12,
			kind: 'text',
			body: 'my favourite bit',
			spoiler: false,
			createdAt: now - 5.5 * MIN,
		},
		{
			id: 'n-spoiler',
			clientId: 'buddy-1',
			name: 'Sam',
			videoId: 'fixture-video',
			timestamp: 16,
			kind: 'text',
			body: 'the twist: the dog did it',
			spoiler: true,
			createdAt: now - 2.5 * HOUR,
		},
		{
			id: 'n-mention',
			clientId: 'buddy-2',
			name: 'Kim',
			videoId: 'fixture-video',
			timestamp: 18,
			kind: 'text',
			body: 'hey @Alex look at this',
			spoiler: false,
			mentions: [VIEWER],
			createdAt: now - 5.5 * MIN,
		},
	];
	const replies = [
		{ id: 'r-1', noteId: 'n-own', clientId: 'buddy-1', name: 'Sam', body: 'love this', createdAt: now - 5.5 * MIN },
		{
			id: 'r-2',
			noteId: 'n-own',
			clientId: 'buddy-2',
			name: 'Kim',
			body: 'same here @Alex',
			mentions: [VIEWER],
			createdAt: now - 4.5 * MIN,
		},
	];
	const playlist = [
		{ videoId: 'vid-live', title: 'Buddy Pick', addedBy: 'buddy-1', addedByName: 'Sam', addedAt: now - 26 * HOUR },
		{ videoId: 'vid-own', title: 'My Pick', addedBy: VIEWER, addedByName: 'Alex', addedAt: now - 25 * HOUR },
		{ videoId: 'vid-inroom', title: 'In Room Pick', addedBy: 'buddy-1', addedByName: 'Sam', addedAt: now - 3.5 * HOUR },
	];
	const events = [
		{ id: 'e1', type: 'added', videoId: 'vid-live', title: 'Buddy Pick', actorClientId: 'buddy-1', at: now - 26 * HOUR },
		{ id: 'e2', type: 'added', videoId: 'vid-own', title: 'My Pick', actorClientId: VIEWER, at: now - 25 * HOUR },
		{ id: 'e3', type: 'added', videoId: 'vid-gone', title: 'Gone Pick', actorClientId: 'buddy-1', at: now - 24.5 * HOUR },
	];
	return { presence, progress, notes, replies, playlist, events };
}

/** Seed the paired-Room config through the popup page; returns the popup. */
export async function seedPaired(context: BrowserContext, storage: Record<string, unknown> = {}): Promise<Page> {
	const extensions = await context.newPage();
	await extensions.goto('chrome://extensions/');
	const item = extensions.locator('extensions-item').filter({ hasText: 'YouTube Buddy' });
	const id = await item.getAttribute('id');
	await extensions.close();
	const popup = await context.newPage();
	await popup.goto(`chrome-extension://${id}/popup/popup.html`);
	await popup.waitForFunction(async () => (await chrome.storage.local.get('clientId')).clientId);
	await popup.evaluate((s) => chrome.storage.local.set(s as Record<string, unknown>), {
		code: 'silly-otters',
		clientId: VIEWER,
		name: 'Alex',
		sharing: true,
		buddyColors: SEED_COLORS,
		...storage,
	});
	return popup;
}

/** Nudge the DOM until the predicate holds (content.js re-emits ytb:mutation). */
export async function nudgeUntil(page: Page, predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		await page.evaluate(() => document.body.appendChild(document.createComment('nudge')));
		try {
			if (await page.evaluate(predicate)) return;
		} catch {
			// keep nudging: the extension may not have injected yet
		}
		if (Date.now() > deadline) throw new Error('nudgeUntil timed out');
		await page.waitForTimeout(250);
	}
}

/** Resolve any CSS color (oklch, color-mix, var-fed) to sRGB via canvas. */
export async function resolveColor(page: Page, cssColor: string, host = 'body'): Promise<[number, number, number, number]> {
	return page.evaluate(
		([color, hostSel]) => {
			const el = document.createElement('div');
			el.style.color = color;
			(document.querySelector(hostSel) || document.body).appendChild(el);
			const computed = getComputedStyle(el).color;
			el.remove();
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 1;
			const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, 0, 1, 1);
			ctx.fillStyle = computed;
			ctx.fillRect(0, 0, 1, 1);
			const d = ctx.getImageData(0, 0, 1, 1).data;
			return [d[0], d[1], d[2], 255] as [number, number, number, number];
		},
		[cssColor, host] as const,
	);
}

function channel(v: number): number {
	const s = v / 255;
	return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance([r, g, b]: [number, number, number, number] | number[]): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: number[], b: number[]): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Resting color of an element and the first opaque background behind it, as sRGB tuples. */
export async function textAndBackground(page: Page, selector: string): Promise<{ fg: number[]; bg: number[] }> {
	const { fg, bg } = await page.evaluate(async (sel) => {
		const el = document.querySelector(sel);
		if (!el) throw new Error('missing ' + sel);

		const read = () => {
			const fg = getComputedStyle(el).color;
			let bg = '';
			let backgroundNode: Element | null = null;
			let node: Element | null = el;
			while (node) {
				const candidate = getComputedStyle(node).backgroundColor;
				if (candidate && !candidate.includes('transparent') && !/rgba\(.*,\s*0\)/.test(candidate)) {
					bg = candidate;
					backgroundNode = node;
					break;
				}
				node = node.parentElement;
			}
			if (!bg) bg = 'rgb(255, 255, 255)';
			return { fg, bg, backgroundNode };
		};

		// Reading computed style registers a just-triggered CSS transition. Give
		// the browser one frame to expose it, then wait for the measured ink and
		// surface colors to reach their resting values before sampling them.
		let sample = read();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const colorProperties = new Set(['color', 'background', 'background-color']);
		const nodes = sample.backgroundNode && sample.backgroundNode !== el ? [el, sample.backgroundNode] : [el];
		const transitions = nodes.flatMap((node) =>
			node
				.getAnimations()
				.filter(
					(animation): animation is CSSTransition =>
						animation instanceof CSSTransition && colorProperties.has(animation.transitionProperty),
				),
		);
		await Promise.all(transitions.map((transition) => transition.finished.catch(() => undefined)));
		sample = read();
		return { fg: sample.fg, bg: sample.bg };
	}, selector);
	return { fg: [...(await resolveColor(page, fg))], bg: [...(await resolveColor(page, bg))] };
}
